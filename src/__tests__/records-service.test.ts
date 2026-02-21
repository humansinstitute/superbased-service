/**
 * Integration tests for RecordsService v3
 *
 * Requires a running Postgres instance.
 * Set POSTGRES_URL env var or defaults to postgres://postgres:postgres@localhost:5432/fluxbase
 *
 * Run: bun test src/__tests__/records-service.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test';
import { getDb, closeDb } from '../db/postgres';
import { RecordsService } from '../services/records';
import { delegationsService } from '../services/delegations';
import type { AuthContext, SyncRecordInputV3 } from '../types';

// ── Fixtures ──────────────────────────────────────────────────

const TABLE = 'superbased_records_v3';
const TEST_RUN_ID = process.env.FLUX_TEST_RUN_ID || 'local';

const APP = `test_app_${TEST_RUN_ID}_a`;
const APP2 = `test_app_${TEST_RUN_ID}_b`;

const OWNER_PK = '1111'.repeat(16);
const DELEGATE_PK = '2222'.repeat(16);
const OTHER_PK = '3333'.repeat(16);
const DELEGATE2_PK = '4444'.repeat(16);

function auth(pubkey: string): AuthContext {
  return { pubkey, npub: `npub_${pubkey.slice(0, 8)}`, isAdmin: false };
}

function record(overrides: Partial<SyncRecordInputV3> = {}): SyncRecordInputV3 {
  return {
    record_id: crypto.randomUUID(),
    encrypted_data: 'enc_data_' + Math.random().toString(36).slice(2),
    encrypted_from: OWNER_PK,
    collection: 'default',
    ...overrides,
  };
}

// ── Setup / Teardown ──────────────────────────────────────────

let service: RecordsService;
let getDelegationSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  const sql = getDb();

  // Create the v3 table + indexes (idempotent)
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
  await sql`CREATE INDEX IF NOT EXISTS idx_records_v3_owner
    ON ${sql(TABLE)} (app_pubkey, user_pubkey, record_state)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_records_v3_delegates
    ON ${sql(TABLE)} USING GIN (delegate_payloads)`;

  service = new RecordsService();
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  // Delete only this suite's rows for isolation (avoid broad table truncation)
  const sql = getDb();
  await sql`
    DELETE FROM ${sql(TABLE)}
    WHERE app_pubkey IN (${APP}, ${APP2})
  `;

  // Default: no delegations exist (getDelegation returns null)
  getDelegationSpy = spyOn(delegationsService, 'getDelegation');
  getDelegationSpy.mockResolvedValue(null);
});

// ── Helper: count rows by state ───────────────────────────────

async function countByState(appPubkey: string, recordId: string) {
  const sql = getDb();
  const rows = await sql`
    SELECT record_state, COUNT(*)::int as count
    FROM ${sql(TABLE)}
    WHERE app_pubkey = ${appPubkey} AND record_id = ${recordId}
    GROUP BY record_state
  `;
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.record_state] = r.count;
  return counts;
}

async function totalRows(appPubkey: string, recordId: string) {
  const sql = getDb();
  const [{ count }] = await sql`
    SELECT COUNT(*)::int as count
    FROM ${sql(TABLE)}
    WHERE app_pubkey = ${appPubkey} AND record_id = ${recordId}
  `;
  return count;
}

// ══════════════════════════════════════════════════════════════
//  RECORD CREATION
// ══════════════════════════════════════════════════════════════

describe('RecordsService v3', () => {

  describe('Record Creation', () => {
    test('creates a new record with version=1', async () => {
      const r = record();
      const result = await service.syncRecords(APP, auth(OWNER_PK), [r]);

      expect(result.created).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.rejected).toEqual([]);
      expect(result.synced).toHaveLength(1);
      expect(result.synced[0].record_id).toBe(r.record_id);
      expect(result.synced[0].version).toBe(1);
    });

    test('created record has record_state=live', async () => {
      const r = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      const states = await countByState(APP, r.record_id);
      expect(states).toEqual({ live: 1 });
    });

    test('defaults collection to "default"', async () => {
      const r = record({ collection: undefined });
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      const fetched = await service.fetchRecords(APP, auth(OWNER_PK));
      expect(fetched.records[0].collection).toBe('default');
    });

    test('uses provided collection', async () => {
      const r = record({ collection: 'todos' });
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      const fetched = await service.fetchRecords(APP, auth(OWNER_PK), 'todos');
      expect(fetched.records).toHaveLength(1);
      expect(fetched.records[0].collection).toBe('todos');
    });

    test('stores encrypted_from field', async () => {
      const r = record({ encrypted_from: DELEGATE_PK });
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      const fetched = await service.fetchRecords(APP, auth(OWNER_PK));
      expect(fetched.records[0].encrypted_from).toBe(DELEGATE_PK);
    });

    test('stores delegate_payloads', async () => {
      const r = record({
        delegate_payloads: {
          [DELEGATE_PK]: 'blob_for_delegate',
          [DELEGATE2_PK]: 'blob_for_delegate2',
        },
      });
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      const fetched = await service.fetchRecords(APP, auth(OWNER_PK));
      expect(fetched.records[0].delegate_payloads).toEqual({
        [DELEGATE_PK]: 'blob_for_delegate',
        [DELEGATE2_PK]: 'blob_for_delegate2',
      });
    });

    test('sync response shape matches spec', async () => {
      const r = record();
      const result = await service.syncRecords(APP, auth(OWNER_PK), [r]);

      // Spec: { synced: [{record_id, version}], created, updated, rejected: [{record_id, reason}] }
      expect(result).toHaveProperty('synced');
      expect(result).toHaveProperty('created');
      expect(result).toHaveProperty('updated');
      expect(result).toHaveProperty('rejected');
      expect(Array.isArray(result.synced)).toBe(true);
      expect(Array.isArray(result.rejected)).toBe(true);
      expect(typeof result.created).toBe('number');
      expect(typeof result.updated).toBe('number');
    });

    test('multiple records in single sync call', async () => {
      const r1 = record();
      const r2 = record();
      const r3 = record();

      const result = await service.syncRecords(APP, auth(OWNER_PK), [r1, r2, r3]);

      expect(result.created).toBe(3);
      expect(result.synced).toHaveLength(3);
      // All should be version 1
      for (const s of result.synced) {
        expect(s.version).toBe(1);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  RECORD UPDATE (VERSIONING)
  // ══════════════════════════════════════════════════════════════

  describe('Record Update (versioning)', () => {
    test('second sync of same record_id returns version=2', async () => {
      const r = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r]);
      const result = await service.syncRecords(APP, auth(OWNER_PK), [
        { ...r, encrypted_data: 'updated_data' },
      ]);

      expect(result.updated).toBe(1);
      expect(result.created).toBe(0);
      expect(result.synced[0].version).toBe(2);
    });

    test('previous version becomes superseded', async () => {
      const r = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r]);
      await service.syncRecords(APP, auth(OWNER_PK), [
        { ...r, encrypted_data: 'v2' },
      ]);

      const states = await countByState(APP, r.record_id);
      expect(states).toEqual({ live: 1, superseded: 1 });
    });

    test('only one live row exists per record (partial unique index)', async () => {
      const r = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r]);
      await service.syncRecords(APP, auth(OWNER_PK), [{ ...r, encrypted_data: 'v2' }]);
      await service.syncRecords(APP, auth(OWNER_PK), [{ ...r, encrypted_data: 'v3' }]);

      const states = await countByState(APP, r.record_id);
      expect(states.live).toBe(1);
      expect(states.superseded).toBe(2);
    });

    test('three sequential updates produce versions 1,2,3', async () => {
      const r = record();
      const r1 = await service.syncRecords(APP, auth(OWNER_PK), [r]);
      const r2 = await service.syncRecords(APP, auth(OWNER_PK), [{ ...r, encrypted_data: 'v2' }]);
      const r3 = await service.syncRecords(APP, auth(OWNER_PK), [{ ...r, encrypted_data: 'v3' }]);

      expect(r1.synced[0].version).toBe(1);
      expect(r2.synced[0].version).toBe(2);
      expect(r3.synced[0].version).toBe(3);
    });

    test('user_pubkey never changes across versions', async () => {
      const r = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r]);
      await service.syncRecords(APP, auth(OWNER_PK), [{ ...r, encrypted_data: 'v2' }]);

      const sql = getDb();
      const rows = await sql`
        SELECT DISTINCT user_pubkey FROM ${sql(TABLE)}
        WHERE app_pubkey = ${APP} AND record_id = ${r.record_id}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].user_pubkey).toBe(OWNER_PK);
    });

    test('encrypted_data and encrypted_from update to new values', async () => {
      const r = record({ encrypted_from: OWNER_PK });
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      await service.syncRecords(APP, auth(OWNER_PK), [
        { ...r, encrypted_data: 'new_data', encrypted_from: DELEGATE_PK },
      ]);

      const fetched = await service.fetchRecords(APP, auth(OWNER_PK));
      expect(fetched.records[0].encrypted_data).toBe('new_data');
      expect(fetched.records[0].encrypted_from).toBe(DELEGATE_PK);
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  RECORD DELETION
  // ══════════════════════════════════════════════════════════════

  describe('Record Deletion', () => {
    test('delete inserts a version with state=deleted', async () => {
      const r = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r]);
      const delResult = await service.deleteRecord(APP, auth(OWNER_PK), r.record_id);

      expect(delResult).not.toBeNull();
      expect(delResult!.version).toBe(2);

      const states = await countByState(APP, r.record_id);
      expect(states.deleted).toBe(1);
    });

    test('previous live row becomes superseded after delete', async () => {
      const r = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r]);
      await service.deleteRecord(APP, auth(OWNER_PK), r.record_id);

      const states = await countByState(APP, r.record_id);
      expect(states.superseded).toBe(1);
      expect(states.live).toBeUndefined();
    });

    test('sync after delete is rejected with reason "record_deleted"', async () => {
      const r = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r]);
      await service.deleteRecord(APP, auth(OWNER_PK), r.record_id);

      const result = await service.syncRecords(APP, auth(OWNER_PK), [
        { ...r, encrypted_data: 'should_fail' },
      ]);

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].record_id).toBe(r.record_id);
      expect(result.rejected[0].reason).toBe('record_deleted');
      expect(result.synced).toHaveLength(0);
    });

    test('delete of non-existent record returns null', async () => {
      const result = await service.deleteRecord(APP, auth(OWNER_PK), crypto.randomUUID());
      expect(result).toBeNull();
    });

    test('double delete returns null', async () => {
      const r = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r]);
      await service.deleteRecord(APP, auth(OWNER_PK), r.record_id);

      const result = await service.deleteRecord(APP, auth(OWNER_PK), r.record_id);
      expect(result).toBeNull();
    });

    test('delete version has empty encrypted_data and encrypted_from', async () => {
      const r = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r]);
      await service.deleteRecord(APP, auth(OWNER_PK), r.record_id);

      const sql = getDb();
      const [deleted] = await sql`
        SELECT encrypted_data, encrypted_from, delegate_payloads
        FROM ${sql(TABLE)}
        WHERE app_pubkey = ${APP} AND record_id = ${r.record_id} AND record_state = 'deleted'
      `;
      expect(deleted.encrypted_data).toBe('');
      expect(deleted.encrypted_from).toBe('');
      expect(deleted.delegate_payloads).toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  FETCH (own records)
  // ══════════════════════════════════════════════════════════════

  describe('Fetch (own records)', () => {
    test('returns only live records', async () => {
      const r1 = record();
      const r2 = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r1, r2]);
      // Update r1 to create a superseded version
      await service.syncRecords(APP, auth(OWNER_PK), [{ ...r1, encrypted_data: 'v2' }]);

      const fetched = await service.fetchRecords(APP, auth(OWNER_PK));
      // Should have exactly 2 live records
      expect(fetched.records).toHaveLength(2);
    });

    test('returns records with version numbers', async () => {
      const r = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r]);
      await service.syncRecords(APP, auth(OWNER_PK), [{ ...r, encrypted_data: 'v2' }]);

      const fetched = await service.fetchRecords(APP, auth(OWNER_PK));
      const found = fetched.records.find(rec => rec.record_id === r.record_id);
      expect(found).toBeDefined();
      expect(found!.version).toBe(2);
    });

    test('excludes superseded records', async () => {
      const r = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r]);
      await service.syncRecords(APP, auth(OWNER_PK), [{ ...r, encrypted_data: 'v2' }]);

      const fetched = await service.fetchRecords(APP, auth(OWNER_PK));
      // Only the live v2, not the superseded v1
      const all = fetched.records.filter(rec => rec.record_id === r.record_id);
      expect(all).toHaveLength(1);
      expect(all[0].version).toBe(2);
    });

    test('excludes deleted records', async () => {
      const r = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r]);
      await service.deleteRecord(APP, auth(OWNER_PK), r.record_id);

      const fetched = await service.fetchRecords(APP, auth(OWNER_PK));
      const found = fetched.records.find(rec => rec.record_id === r.record_id);
      expect(found).toBeUndefined();
    });

    test('collection filter works', async () => {
      const r1 = record({ collection: 'todos' });
      const r2 = record({ collection: 'notes' });
      await service.syncRecords(APP, auth(OWNER_PK), [r1, r2]);

      const todos = await service.fetchRecords(APP, auth(OWNER_PK), 'todos');
      expect(todos.records).toHaveLength(1);
      expect(todos.records[0].record_id).toBe(r1.record_id);
    });

    test('since filter works', async () => {
      const r1 = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r1]);

      // Use a generous delay so Postgres timestamps differ
      await new Promise(resolve => setTimeout(resolve, 50));

      // Capture timestamp AFTER the delay
      const sql = getDb();
      const [{ now }] = await sql`SELECT now()::text as now`;

      // Another delay before inserting the second record
      await new Promise(resolve => setTimeout(resolve, 50));

      const r2 = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r2]);

      const fetched = await service.fetchRecords(APP, auth(OWNER_PK), undefined, now);
      expect(fetched.records).toHaveLength(1);
      expect(fetched.records[0].record_id).toBe(r2.record_id);
    });

    test('does not return records from other users', async () => {
      const r1 = record();
      const r2 = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r1]);
      await service.syncRecords(APP, auth(OTHER_PK), [r2]);

      const ownerRecords = await service.fetchRecords(APP, auth(OWNER_PK));
      expect(ownerRecords.records).toHaveLength(1);
      expect(ownerRecords.records[0].record_id).toBe(r1.record_id);
    });

    test('response includes encrypted_from', async () => {
      const r = record({ encrypted_from: DELEGATE_PK });
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      const fetched = await service.fetchRecords(APP, auth(OWNER_PK));
      expect(fetched.records[0].encrypted_from).toBe(DELEGATE_PK);
    });

    test('response includes created_at', async () => {
      const r = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      const fetched = await service.fetchRecords(APP, auth(OWNER_PK));
      expect(fetched.records[0].created_at).toBeDefined();
    });

    test('omits delegate_payloads when null', async () => {
      const r = record(); // no delegate_payloads
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      const fetched = await service.fetchRecords(APP, auth(OWNER_PK));
      expect(fetched.records[0].delegate_payloads).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  DELEGATED FETCH
  // ══════════════════════════════════════════════════════════════

  describe('Delegated Fetch', () => {
    test('returns records where delegate has entry in delegate_payloads', async () => {
      const r = record({
        delegate_payloads: { [DELEGATE_PK]: 'blob_for_delegate' },
      });
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      const fetched = await service.fetchDelegatedRecords(APP, DELEGATE_PK);
      expect(fetched.records).toHaveLength(1);
      expect(fetched.records[0].record_id).toBe(r.record_id);
    });

    test('returns only the requesting delegate\'s payload (singular field)', async () => {
      const r = record({
        delegate_payloads: {
          [DELEGATE_PK]: 'blob_A',
          [DELEGATE2_PK]: 'blob_B',
        },
      });
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      const fetched = await service.fetchDelegatedRecords(APP, DELEGATE_PK);
      expect(fetched.records[0].delegate_payload).toBe('blob_A');
      // No delegate_payloads map — only singular delegate_payload
      expect((fetched.records[0] as any).delegate_payloads).toBeUndefined();
    });

    test('strips encrypted_data (owner\'s blob) from delegate response', async () => {
      const r = record({
        delegate_payloads: { [DELEGATE_PK]: 'blob' },
      });
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      const fetched = await service.fetchDelegatedRecords(APP, DELEGATE_PK);
      expect((fetched.records[0] as any).encrypted_data).toBeUndefined();
    });

    test('strips other delegates\' payloads', async () => {
      const r = record({
        delegate_payloads: {
          [DELEGATE_PK]: 'blob_A',
          [DELEGATE2_PK]: 'blob_B',
        },
      });
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      // Fetch as DELEGATE_PK — should not see DELEGATE2_PK's blob
      const fetched = await service.fetchDelegatedRecords(APP, DELEGATE_PK);
      expect(fetched.records[0].delegate_payload).toBe('blob_A');
      // Ensure no leakage of other delegate's data
      const raw = JSON.stringify(fetched.records[0]);
      expect(raw).not.toContain('blob_B');
    });

    test('includes owner_pubkey in response', async () => {
      const r = record({
        delegate_payloads: { [DELEGATE_PK]: 'blob' },
      });
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      const fetched = await service.fetchDelegatedRecords(APP, DELEGATE_PK);
      expect(fetched.records[0].owner_pubkey).toBe(OWNER_PK);
    });

    test('includes version and encrypted_from', async () => {
      const r = record({
        encrypted_from: OWNER_PK,
        delegate_payloads: { [DELEGATE_PK]: 'blob' },
      });
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      const fetched = await service.fetchDelegatedRecords(APP, DELEGATE_PK);
      expect(fetched.records[0].version).toBe(1);
      expect(fetched.records[0].encrypted_from).toBe(OWNER_PK);
    });

    test('collection filter works', async () => {
      const r1 = record({
        collection: 'todos',
        delegate_payloads: { [DELEGATE_PK]: 'blob1' },
      });
      const r2 = record({
        collection: 'notes',
        delegate_payloads: { [DELEGATE_PK]: 'blob2' },
      });
      await service.syncRecords(APP, auth(OWNER_PK), [r1, r2]);

      const fetched = await service.fetchDelegatedRecords(APP, DELEGATE_PK, 'todos');
      expect(fetched.records).toHaveLength(1);
      expect(fetched.records[0].collection).toBe('todos');
    });

    test('owner filter works', async () => {
      const r1 = record({ delegate_payloads: { [DELEGATE_PK]: 'blob1' } });
      const r2 = record({ delegate_payloads: { [DELEGATE_PK]: 'blob2' } });
      await service.syncRecords(APP, auth(OWNER_PK), [r1]);
      await service.syncRecords(APP, auth(OTHER_PK), [r2]);

      const fetched = await service.fetchDelegatedRecords(APP, DELEGATE_PK, undefined, OWNER_PK);
      expect(fetched.records).toHaveLength(1);
      expect(fetched.records[0].owner_pubkey).toBe(OWNER_PK);
    });

    test('does not return superseded or deleted records', async () => {
      const r = record({ delegate_payloads: { [DELEGATE_PK]: 'blob_v1' } });
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      // Update — v1 becomes superseded, v2 is live
      await service.syncRecords(APP, auth(OWNER_PK), [
        { ...r, encrypted_data: 'v2', delegate_payloads: { [DELEGATE_PK]: 'blob_v2' } },
      ]);

      const fetched = await service.fetchDelegatedRecords(APP, DELEGATE_PK);
      expect(fetched.records).toHaveLength(1);
      expect(fetched.records[0].delegate_payload).toBe('blob_v2');
    });

    test('returns empty when delegate not in any record', async () => {
      const r = record({
        delegate_payloads: { [DELEGATE2_PK]: 'blob_for_other' },
      });
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      const fetched = await service.fetchDelegatedRecords(APP, DELEGATE_PK);
      expect(fetched.records).toHaveLength(0);
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  HISTORY
  // ══════════════════════════════════════════════════════════════

  describe('History', () => {
    test('returns all versions ordered by version ASC', async () => {
      const r = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r]);
      await service.syncRecords(APP, auth(OWNER_PK), [{ ...r, encrypted_data: 'v2' }]);
      await service.syncRecords(APP, auth(OWNER_PK), [{ ...r, encrypted_data: 'v3' }]);

      const history = await service.getRecordHistory(APP, r.record_id);
      expect(history).not.toBeNull();
      expect(history!.versions).toHaveLength(3);
      expect(history!.versions[0].version).toBe(1);
      expect(history!.versions[1].version).toBe(2);
      expect(history!.versions[2].version).toBe(3);
    });

    test('includes record_state for each version', async () => {
      const r = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r]);
      await service.syncRecords(APP, auth(OWNER_PK), [{ ...r, encrypted_data: 'v2' }]);
      await service.deleteRecord(APP, auth(OWNER_PK), r.record_id);

      const history = await service.getRecordHistory(APP, r.record_id);
      expect(history!.versions[0].record_state).toBe('superseded');
      expect(history!.versions[1].record_state).toBe('superseded');
      expect(history!.versions[2].record_state).toBe('deleted');
    });

    test('includes owner_pubkey at top level', async () => {
      const r = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      const history = await service.getRecordHistory(APP, r.record_id);
      expect(history!.owner_pubkey).toBe(OWNER_PK);
    });

    test('without include_data, omits encrypted_data and delegate_payloads', async () => {
      const r = record({ delegate_payloads: { [DELEGATE_PK]: 'blob' } });
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      const history = await service.getRecordHistory(APP, r.record_id, false);
      expect(history!.versions[0].encrypted_data).toBeUndefined();
      expect(history!.versions[0].delegate_payloads).toBeUndefined();
    });

    test('with include_data=true, includes encrypted_data and delegate_payloads', async () => {
      const r = record({ delegate_payloads: { [DELEGATE_PK]: 'blob' } });
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      const history = await service.getRecordHistory(APP, r.record_id, true);
      expect(history!.versions[0].encrypted_data).toBe(r.encrypted_data);
      expect(history!.versions[0].delegate_payloads).toEqual({ [DELEGATE_PK]: 'blob' });
    });

    test('non-existent record returns null', async () => {
      const history = await service.getRecordHistory(APP, crypto.randomUUID());
      expect(history).toBeNull();
    });

    test('includes encrypted_from for each version', async () => {
      const r = record({ encrypted_from: OWNER_PK });
      await service.syncRecords(APP, auth(OWNER_PK), [r]);
      await service.syncRecords(APP, auth(OWNER_PK), [
        { ...r, encrypted_data: 'v2', encrypted_from: DELEGATE_PK },
      ]);

      const history = await service.getRecordHistory(APP, r.record_id);
      expect(history!.versions[0].encrypted_from).toBe(OWNER_PK);
      expect(history!.versions[1].encrypted_from).toBe(DELEGATE_PK);
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  PERMISSIONS
  // ══════════════════════════════════════════════════════════════

  describe('Permissions', () => {
    test('owner can always write', async () => {
      const r = record();
      const result = await service.syncRecords(APP, auth(OWNER_PK), [r]);
      expect(result.synced).toHaveLength(1);
      expect(result.rejected).toHaveLength(0);
    });

    test('non-owner without delegation is rejected on update', async () => {
      const r = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      // getDelegation returns null (default mock)
      const result = await service.syncRecords(APP, auth(OTHER_PK), [
        { ...r, encrypted_data: 'hacked' },
      ]);

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toBe('no_permission');
    });

    test('non-owner with write delegation is allowed to update', async () => {
      const r = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      // Mock: DELEGATE_PK has write delegation from OWNER_PK
      getDelegationSpy.mockResolvedValue({
        id: 'del-1',
        app_pubkey: APP,
        owner_pubkey: OWNER_PK,
        delegate_pubkey: DELEGATE_PK,
        permissions: ['write'],
        created_at: new Date().toISOString(),
      });

      const result = await service.syncRecords(APP, auth(DELEGATE_PK), [
        { ...r, encrypted_data: 'delegated_update', encrypted_from: DELEGATE_PK },
      ]);

      expect(result.synced).toHaveLength(1);
      expect(result.synced[0].version).toBe(2);
    });

    test('delegate can create on behalf of owner (owner_pubkey field)', async () => {
      // Mock: DELEGATE_PK has write delegation from OWNER_PK
      getDelegationSpy.mockResolvedValue({
        id: 'del-1',
        app_pubkey: APP,
        owner_pubkey: OWNER_PK,
        delegate_pubkey: DELEGATE_PK,
        permissions: ['write'],
        created_at: new Date().toISOString(),
      });

      const r = record({
        owner_pubkey: OWNER_PK,
        encrypted_from: DELEGATE_PK,
      });
      const result = await service.syncRecords(APP, auth(DELEGATE_PK), [r]);

      expect(result.synced).toHaveLength(1);
      expect(result.synced[0].version).toBe(1);

      // Verify the record is owned by OWNER_PK, not DELEGATE_PK
      const fetched = await service.fetchRecords(APP, auth(OWNER_PK));
      expect(fetched.records).toHaveLength(1);
      expect(fetched.records[0].encrypted_from).toBe(DELEGATE_PK);

      // DELEGATE_PK should have no own records
      const delegateFetched = await service.fetchRecords(APP, auth(DELEGATE_PK));
      expect(delegateFetched.records).toHaveLength(0);
    });

    test('create on behalf without delegation is rejected', async () => {
      // getDelegation returns null (default)
      const r = record({ owner_pubkey: OWNER_PK });
      const result = await service.syncRecords(APP, auth(OTHER_PK), [r]);

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toBe('no_permission');
    });

    test('non-owner cannot delete without delegation', async () => {
      const r = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      const result = await service.deleteRecord(APP, auth(OTHER_PK), r.record_id);
      expect(result).toBeNull();
    });

    test('non-owner with delegation can delete', async () => {
      const r = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      getDelegationSpy.mockResolvedValue({
        id: 'del-1',
        app_pubkey: APP,
        owner_pubkey: OWNER_PK,
        delegate_pubkey: DELEGATE_PK,
        permissions: ['write'],
        created_at: new Date().toISOString(),
      });

      const result = await service.deleteRecord(APP, auth(DELEGATE_PK), r.record_id);
      expect(result).not.toBeNull();
      expect(result!.version).toBe(2);
    });

    test('read-only delegation is not sufficient for write', async () => {
      const r = record();
      await service.syncRecords(APP, auth(OWNER_PK), [r]);

      getDelegationSpy.mockResolvedValue({
        id: 'del-1',
        app_pubkey: APP,
        owner_pubkey: OWNER_PK,
        delegate_pubkey: OTHER_PK,
        permissions: ['read'], // read only, no write
        created_at: new Date().toISOString(),
      });

      const result = await service.syncRecords(APP, auth(OTHER_PK), [
        { ...r, encrypted_data: 'should_fail' },
      ]);

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toBe('no_permission');
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  ISOLATION
  // ══════════════════════════════════════════════════════════════

  describe('Isolation', () => {
    test('different app_pubkeys don\'t interfere', async () => {
      const rid = crypto.randomUUID();
      const r1 = record({ record_id: rid });
      const r2 = record({ record_id: rid });

      await service.syncRecords(APP, auth(OWNER_PK), [r1]);
      await service.syncRecords(APP2, auth(OWNER_PK), [r2]);

      const app1Records = await service.fetchRecords(APP, auth(OWNER_PK));
      const app2Records = await service.fetchRecords(APP2, auth(OWNER_PK));

      expect(app1Records.records).toHaveLength(1);
      expect(app2Records.records).toHaveLength(1);
      expect(app1Records.records[0].encrypted_data).toBe(r1.encrypted_data);
      expect(app2Records.records[0].encrypted_data).toBe(r2.encrypted_data);
    });

    test('different user_pubkeys don\'t interfere', async () => {
      const r1 = record();
      const r2 = record();

      await service.syncRecords(APP, auth(OWNER_PK), [r1]);
      await service.syncRecords(APP, auth(OTHER_PK), [r2]);

      const ownerRecords = await service.fetchRecords(APP, auth(OWNER_PK));
      const otherRecords = await service.fetchRecords(APP, auth(OTHER_PK));

      expect(ownerRecords.records).toHaveLength(1);
      expect(otherRecords.records).toHaveLength(1);
      expect(ownerRecords.records[0].record_id).toBe(r1.record_id);
      expect(otherRecords.records[0].record_id).toBe(r2.record_id);
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  SPEC COMPLIANCE: COMPLETE LIFECYCLE
  // ══════════════════════════════════════════════════════════════

  describe('Full Lifecycle (spec compliance)', () => {
    test('CREATE → UPDATE → UPDATE → DELETE → REJECT', async () => {
      const r = record({ collection: 'todos' });

      // CREATE
      const c = await service.syncRecords(APP, auth(OWNER_PK), [r]);
      expect(c.synced[0].version).toBe(1);
      expect(c.created).toBe(1);

      // UPDATE #1
      const u1 = await service.syncRecords(APP, auth(OWNER_PK), [
        { ...r, encrypted_data: 'v2_data', encrypted_from: OWNER_PK },
      ]);
      expect(u1.synced[0].version).toBe(2);
      expect(u1.updated).toBe(1);

      // UPDATE #2
      const u2 = await service.syncRecords(APP, auth(OWNER_PK), [
        { ...r, encrypted_data: 'v3_data', encrypted_from: OWNER_PK },
      ]);
      expect(u2.synced[0].version).toBe(3);

      // Verify fetch returns latest live version
      const fetched = await service.fetchRecords(APP, auth(OWNER_PK));
      const found = fetched.records.find(rec => rec.record_id === r.record_id);
      expect(found!.version).toBe(3);
      expect(found!.encrypted_data).toBe('v3_data');

      // DELETE
      const del = await service.deleteRecord(APP, auth(OWNER_PK), r.record_id);
      expect(del!.version).toBe(4);

      // REJECT: sync after delete
      const rejected = await service.syncRecords(APP, auth(OWNER_PK), [
        { ...r, encrypted_data: 'should_be_rejected' },
      ]);
      expect(rejected.rejected[0].reason).toBe('record_deleted');

      // Verify history shows complete chain
      const history = await service.getRecordHistory(APP, r.record_id);
      expect(history!.versions).toHaveLength(4);
      expect(history!.versions.map(v => v.record_state)).toEqual([
        'superseded', 'superseded', 'superseded', 'deleted',
      ]);
      expect(history!.versions.map(v => v.version)).toEqual([1, 2, 3, 4]);

      // Verify total rows = 4
      const rows = await totalRows(APP, r.record_id);
      expect(rows).toBe(4);
    });
  });
});
