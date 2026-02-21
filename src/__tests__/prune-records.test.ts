/**
 * Integration tests for the records prune logic
 *
 * Requires a running Postgres instance.
 * Set POSTGRES_URL env var or defaults to postgres://postgres:postgres@localhost:5432/fluxbase
 *
 * Run: bun test src/__tests__/prune-records.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { getDb, closeDb } from '../db/postgres';

const TABLE = 'superbased_records_v3';
const TEST_RUN_ID = process.env.FLUX_TEST_RUN_ID || 'local';
const APP = `test_prune_app_${TEST_RUN_ID}`;
const USER = 'uuuu'.repeat(16);

// ── Setup ─────────────────────────────────────────────────────

beforeAll(async () => {
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS ${sql(TABLE)} (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      app_pubkey      text NOT NULL,
      record_id       text NOT NULL,
      user_pubkey     text NOT NULL,
      version         integer NOT NULL,
      record_state    text NOT NULL CHECK (record_state IN ('live', 'superseded', 'deleted')),
      collection      text NOT NULL DEFAULT 'default',
      encrypted_data  text NOT NULL,
      encrypted_from  text NOT NULL,
      delegate_payloads jsonb,
      created_at      timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_records_v3_version
    ON ${sql(TABLE)} (app_pubkey, record_id, version)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_records_v3_live
    ON ${sql(TABLE)} (app_pubkey, record_id) WHERE record_state = 'live'`;
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  const sql = getDb();
  await sql`DELETE FROM ${sql(TABLE)} WHERE app_pubkey = ${APP}`;
});

// ── Helpers ───────────────────────────────────────────────────

/** Insert N superseded versions + 1 live version for a record */
async function insertVersionChain(
  recordId: string,
  totalVersions: number,
  opts?: { finalState?: 'live' | 'deleted' }
) {
  const sql = getDb();
  const finalState = opts?.finalState ?? 'live';

  for (let v = 1; v <= totalVersions; v++) {
    const isLast = v === totalVersions;
    const state = isLast ? finalState : 'superseded';
    await sql`
      INSERT INTO ${sql(TABLE)} (
        app_pubkey, record_id, user_pubkey, version, record_state,
        collection, encrypted_data, encrypted_from
      ) VALUES (
        ${APP}, ${recordId}, ${USER}, ${v}, ${state},
        'default', ${'data_v' + v}, ${USER}
      )
    `;
  }
}

/**
 * Prune logic extracted from prune-records.ts so we can test it in-process
 * without running a separate CLI script.
 */
async function runPrune(): Promise<number> {
  const sql = getDb();

  const candidates = await sql`
    SELECT app_pubkey, record_id, COUNT(*)::int as total
    FROM ${sql(TABLE)}
    GROUP BY app_pubkey, record_id
    HAVING COUNT(*) > 21
  `;

  let totalPruned = 0;

  for (const { app_pubkey, record_id } of candidates) {
    const result = await sql`
      DELETE FROM ${sql(TABLE)}
      WHERE id IN (
        SELECT id FROM ${sql(TABLE)}
        WHERE app_pubkey = ${app_pubkey}
          AND record_id = ${record_id}
          AND record_state = 'superseded'
        ORDER BY version DESC
        OFFSET 20
      )
    `;
    totalPruned += result.count;
  }

  return totalPruned;
}

async function countRows(recordId: string): Promise<Record<string, number>> {
  const sql = getDb();
  const rows = await sql`
    SELECT record_state, COUNT(*)::int as count
    FROM ${sql(TABLE)}
    WHERE app_pubkey = ${APP} AND record_id = ${recordId}
    GROUP BY record_state
  `;
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.record_state] = r.count;
  counts.total = Object.values(counts).reduce((a, b) => a + b, 0);
  return counts;
}

// ── Tests ─────────────────────────────────────────────────────

describe('Record Pruning', () => {

  test('records with <=21 versions are not pruned', async () => {
    const rid = crypto.randomUUID();
    await insertVersionChain(rid, 21); // 20 superseded + 1 live = 21 total

    const pruned = await runPrune();
    expect(pruned).toBe(0);

    const counts = await countRows(rid);
    expect(counts.total).toBe(21);
  });

  test('superseded versions beyond 20 most recent are pruned', async () => {
    const rid = crypto.randomUUID();
    // 24 superseded + 1 live = 25 total
    await insertVersionChain(rid, 25);

    const pruned = await runPrune();
    expect(pruned).toBe(4); // 24 superseded - 20 kept = 4 pruned

    const counts = await countRows(rid);
    expect(counts.total).toBe(21); // 20 superseded + 1 live
    expect(counts.superseded).toBe(20);
    expect(counts.live).toBe(1);
  });

  test('live row is never pruned', async () => {
    const rid = crypto.randomUUID();
    await insertVersionChain(rid, 30);

    await runPrune();

    const counts = await countRows(rid);
    expect(counts.live).toBe(1);
  });

  test('deleted row is never pruned', async () => {
    const rid = crypto.randomUUID();
    await insertVersionChain(rid, 30, { finalState: 'deleted' });

    await runPrune();

    const counts = await countRows(rid);
    expect(counts.deleted).toBe(1);
  });

  test('keeps exactly 20 most recent superseded + final state row', async () => {
    const rid = crypto.randomUUID();
    await insertVersionChain(rid, 40); // 39 superseded + 1 live = 40

    await runPrune();

    const counts = await countRows(rid);
    expect(counts.superseded).toBe(20);
    expect(counts.live).toBe(1);
    expect(counts.total).toBe(21);

    // Verify the kept superseded versions are the most recent ones (highest version numbers)
    const sql = getDb();
    const keptVersions = await sql`
      SELECT version FROM ${sql(TABLE)}
      WHERE app_pubkey = ${APP} AND record_id = ${rid} AND record_state = 'superseded'
      ORDER BY version ASC
    `;
    // Versions 1-19 should be pruned; 20-39 kept
    expect(keptVersions[0].version).toBe(20);
    expect(keptVersions[keptVersions.length - 1].version).toBe(39);
  });

  test('prune is idempotent (running twice has same result)', async () => {
    const rid = crypto.randomUUID();
    await insertVersionChain(rid, 30);

    await runPrune();
    const countsAfterFirst = await countRows(rid);

    await runPrune();
    const countsAfterSecond = await countRows(rid);

    expect(countsAfterFirst).toEqual(countsAfterSecond);
  });

  test('prune handles multiple records independently', async () => {
    const rid1 = crypto.randomUUID();
    const rid2 = crypto.randomUUID();
    const rid3 = crypto.randomUUID();

    await insertVersionChain(rid1, 25);  // needs pruning
    await insertVersionChain(rid2, 15);  // doesn't need pruning
    await insertVersionChain(rid3, 30);  // needs pruning

    const pruned = await runPrune();

    const counts1 = await countRows(rid1);
    const counts2 = await countRows(rid2);
    const counts3 = await countRows(rid3);

    expect(counts1.total).toBe(21);
    expect(counts2.total).toBe(15); // unchanged
    expect(counts3.total).toBe(21);
    expect(pruned).toBe(4 + 9); // (25-21) + (30-21) = 4 + 9 = 13
  });
});
