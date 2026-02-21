import webpush from 'web-push';
import { getConfig } from '../config';
import { getDb } from '../db/postgres';
import type { PushSubscriptionInput, SyncOutcomeRecord } from '../types';

const PUSH_TABLE = 'superbased_push_subscriptions';

type StoredPushSubscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
  collections: string[] | null;
};

export class PushService {
  private isConfigured: boolean;

  constructor() {
    const config = getConfig();
    this.isConfigured = Boolean(
      config.pushEnabled &&
      config.pushVapidPublicKey &&
      config.pushVapidPrivateKey &&
      config.pushVapidSubject
    );

    if (this.isConfigured) {
      webpush.setVapidDetails(
        config.pushVapidSubject as string,
        config.pushVapidPublicKey as string,
        config.pushVapidPrivateKey as string
      );
    }
  }

  enabled(): boolean {
    return this.isConfigured;
  }

  async upsertSubscription(
    appPubkey: string,
    ownerPubkey: string,
    subscription: PushSubscriptionInput,
    collections: string[] = [],
    deviceId?: string,
    userAgent?: string
  ): Promise<void> {
    const sql = getDb();
    const normalizedCollections = collections.map((c) => c.trim()).filter(Boolean);

    await sql`
      INSERT INTO ${sql(PUSH_TABLE)} (
        app_pubkey, owner_pubkey, endpoint, p256dh, auth, collections, device_id, user_agent
      ) VALUES (
        ${appPubkey},
        ${ownerPubkey},
        ${subscription.endpoint},
        ${subscription.keys.p256dh},
        ${subscription.keys.auth},
        ${sql.array(normalizedCollections)},
        ${deviceId || null},
        ${userAgent || null}
      )
      ON CONFLICT (app_pubkey, owner_pubkey, endpoint)
      DO UPDATE SET
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        collections = EXCLUDED.collections,
        device_id = EXCLUDED.device_id,
        user_agent = EXCLUDED.user_agent,
        updated_at = now()
    `;
  }

  async deleteSubscription(appPubkey: string, ownerPubkey: string, endpoint: string): Promise<boolean> {
    const sql = getDb();
    const result = await sql`
      DELETE FROM ${sql(PUSH_TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND owner_pubkey = ${ownerPubkey}
        AND endpoint = ${endpoint}
    `;
    return result.count > 0;
  }

  async listSubscriptions(appPubkey: string, ownerPubkey: string): Promise<any[]> {
    const sql = getDb();
    return sql`
      SELECT endpoint, collections, device_id, created_at, updated_at, last_success_at, last_error_at
      FROM ${sql(PUSH_TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND owner_pubkey = ${ownerPubkey}
      ORDER BY updated_at DESC
    `;
  }

  async notifyOnSyncOutcomes(appPubkey: string, actorPubkey: string, outcomes: SyncOutcomeRecord[]): Promise<void> {
    if (!this.isConfigured || outcomes.length === 0) return;

    const newRemoteChatRecords = outcomes.filter(
      (o) => o.collection === 'chat_messages' && o.version === 1 && o.owner_pubkey !== actorPubkey
    );
    if (newRemoteChatRecords.length === 0) return;

    for (const outcome of newRemoteChatRecords) {
      await this.notifyOwnerForRecord(appPubkey, actorPubkey, outcome);
    }
  }

  private async notifyOwnerForRecord(appPubkey: string, actorPubkey: string, outcome: SyncOutcomeRecord): Promise<void> {
    const subscriptions = await this.getSubscriptions(appPubkey, outcome.owner_pubkey);
    if (subscriptions.length === 0) return;

    const payload = JSON.stringify({
      type: 'chat_message_created',
      app_pubkey: appPubkey,
      collection: outcome.collection,
      record_id: outcome.record_id,
      owner_pubkey: outcome.owner_pubkey,
      actor_pubkey: actorPubkey,
      ts: Date.now(),
    });

    for (const sub of subscriptions) {
      const allowedCollections = sub.collections || [];
      if (allowedCollections.length > 0 && !allowedCollections.includes('chat_messages')) {
        continue;
      }

      const pushSub = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.p256dh,
          auth: sub.auth,
        },
      };

      try {
        await webpush.sendNotification(pushSub, payload, { TTL: 60 });
        await this.markSuccess(sub.endpoint, appPubkey, outcome.owner_pubkey);
      } catch (err: any) {
        await this.markError(sub.endpoint, appPubkey, outcome.owner_pubkey);
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await this.deleteSubscription(appPubkey, outcome.owner_pubkey, sub.endpoint);
        }
      }
    }
  }

  private async getSubscriptions(appPubkey: string, ownerPubkey: string): Promise<StoredPushSubscription[]> {
    const sql = getDb();
    return sql`
      SELECT endpoint, p256dh, auth, collections
      FROM ${sql(PUSH_TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND owner_pubkey = ${ownerPubkey}
    ` as unknown as StoredPushSubscription[];
  }

  private async markSuccess(endpoint: string, appPubkey: string, ownerPubkey: string): Promise<void> {
    const sql = getDb();
    await sql`
      UPDATE ${sql(PUSH_TABLE)}
      SET last_success_at = now(), updated_at = now()
      WHERE endpoint = ${endpoint}
        AND app_pubkey = ${appPubkey}
        AND owner_pubkey = ${ownerPubkey}
    `;
  }

  private async markError(endpoint: string, appPubkey: string, ownerPubkey: string): Promise<void> {
    const sql = getDb();
    await sql`
      UPDATE ${sql(PUSH_TABLE)}
      SET last_error_at = now(), updated_at = now()
      WHERE endpoint = ${endpoint}
        AND app_pubkey = ${appPubkey}
        AND owner_pubkey = ${ownerPubkey}
    `;
  }
}

export const pushService = new PushService();
