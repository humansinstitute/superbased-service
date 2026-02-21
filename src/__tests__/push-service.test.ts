/**
 * Integration tests for PushService notification behavior.
 *
 * Runs against the test database only (enforced by test-preload).
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, spyOn } from 'bun:test';
import webpush from 'web-push';
import { getDb, closeDb } from '../db/postgres';
import { PushService } from '../services/push';
import type { SyncOutcomeRecord } from '../types';

const TABLE = 'superbased_push_subscriptions';
const TEST_RUN_ID = process.env.FLUX_TEST_RUN_ID || 'local';
const APP = `test_push_app_${TEST_RUN_ID}`;
const OWNER = 'owner_pubkey_test';
const ACTOR = 'actor_pubkey_test';

function outcome(overrides: Partial<SyncOutcomeRecord> = {}): SyncOutcomeRecord {
  return {
    record_id: crypto.randomUUID(),
    version: 1,
    owner_pubkey: OWNER,
    collection: 'chat_messages',
    ...overrides,
  };
}

async function insertSubscription(options?: { endpoint?: string; collections?: string[] }) {
  const sql = getDb();
  const endpoint = options?.endpoint || `https://example.com/push/${crypto.randomUUID()}`;
  const collections = options?.collections || [];

  await sql`
    INSERT INTO ${sql(TABLE)} (
      app_pubkey, owner_pubkey, endpoint, p256dh, auth, collections
    ) VALUES (
      ${APP},
      ${OWNER},
      ${endpoint},
      ${'p256dh_key'},
      ${'auth_key'},
      ${sql.array(collections)}
    )
  `;

  return endpoint;
}

beforeAll(async () => {
  const sql = getDb();

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql(TABLE)} (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      app_pubkey      text NOT NULL,
      owner_pubkey    text NOT NULL,
      endpoint        text NOT NULL,
      p256dh          text NOT NULL,
      auth            text NOT NULL,
      collections     text[] NOT NULL DEFAULT ARRAY[]::text[],
      device_id       text,
      user_agent      text,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      last_success_at timestamptz,
      last_error_at   timestamptz
    )
  `;

  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_push_subscription_endpoint
    ON ${sql(TABLE)} (app_pubkey, owner_pubkey, endpoint)`;

  await sql`CREATE INDEX IF NOT EXISTS idx_push_owner_app
    ON ${sql(TABLE)} (app_pubkey, owner_pubkey)`;
});

beforeEach(async () => {
  const sql = getDb();
  await sql`DELETE FROM ${sql(TABLE)} WHERE app_pubkey = ${APP}`;
});

afterAll(async () => {
  await closeDb();
});

describe('PushService', () => {
  test('sends push for new remote chat_messages and ai_summaries', async () => {
    await insertSubscription();

    const sendSpy = spyOn(webpush, 'sendNotification');
    sendSpy.mockResolvedValue({ statusCode: 201 } as any);

    const service = new PushService();
    (service as any).isConfigured = true;

    await service.notifyOnSyncOutcomes(APP, ACTOR, [
      outcome({ collection: 'chat_messages' }),
      outcome({ collection: 'ai_summaries' }),
    ]);

    expect(sendSpy).toHaveBeenCalledTimes(2);

    const firstPayload = JSON.parse(sendSpy.mock.calls[0][1] as string);
    const secondPayload = JSON.parse(sendSpy.mock.calls[1][1] as string);
    expect(firstPayload.type).toBe('chat_messages_created');
    expect(secondPayload.type).toBe('ai_summaries_created');

    sendSpy.mockRestore();
  });

  test('does not send for non-notifiable collections or non-new versions', async () => {
    await insertSubscription();

    const sendSpy = spyOn(webpush, 'sendNotification');
    sendSpy.mockResolvedValue({ statusCode: 201 } as any);

    const service = new PushService();
    (service as any).isConfigured = true;

    await service.notifyOnSyncOutcomes(APP, ACTOR, [
      outcome({ collection: 'todos' }),
      outcome({ collection: 'chat_messages', version: 2 }),
      outcome({ collection: 'ai_summaries', owner_pubkey: ACTOR }),
    ]);

    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();
  });

  test('respects subscription collection filters', async () => {
    await insertSubscription({ collections: ['chat_messages'] });

    const sendSpy = spyOn(webpush, 'sendNotification');
    sendSpy.mockResolvedValue({ statusCode: 201 } as any);

    const service = new PushService();
    (service as any).isConfigured = true;

    await service.notifyOnSyncOutcomes(APP, ACTOR, [
      outcome({ collection: 'chat_messages' }),
      outcome({ collection: 'ai_summaries' }),
    ]);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(sendSpy.mock.calls[0][1] as string);
    expect(payload.collection).toBe('chat_messages');

    sendSpy.mockRestore();
  });

  test('removes dead subscriptions on HTTP 410/404 from push provider', async () => {
    const endpoint = await insertSubscription();

    const sendSpy = spyOn(webpush, 'sendNotification');
    sendSpy.mockRejectedValue({ statusCode: 410 });

    const service = new PushService();
    (service as any).isConfigured = true;

    await service.notifyOnSyncOutcomes(APP, ACTOR, [outcome({ collection: 'chat_messages' })]);

    const sql = getDb();
    const rows = await sql`
      SELECT endpoint FROM ${sql(TABLE)}
      WHERE app_pubkey = ${APP}
        AND owner_pubkey = ${OWNER}
        AND endpoint = ${endpoint}
    `;

    expect(rows).toHaveLength(0);
    sendSpy.mockRestore();
  });
});
