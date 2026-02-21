import { getDb } from '../db/postgres';
import { delegationsService } from './delegations';
import type {
  AuthContext,
  SyncRecordInputV3,
  SyncResultV3,
  FetchResultV3,
  RecordOutputV3,
  DelegatedRecordOutputV3,
  DelegatedFetchResultV3,
  HistoryResultV3,
  HistoryVersionV3,
  SyncOutcomeRecord,
} from '../types';

const TABLE = 'superbased_records_v3';

/**
 * Service for v3 append-only versioned encrypted records
 */
export class RecordsService {
  /**
   * Sync records — append-only versioned upsert with atomic CTE
   */
  async syncRecords(
    appPubkey: string,
    auth: AuthContext,
    records: SyncRecordInputV3[]
  ): Promise<SyncResultV3 & { outcomes: SyncOutcomeRecord[] }> {
    const sql = getDb();
    const synced: { record_id: string; version: number }[] = [];
    const rejected: { record_id: string; reason: string }[] = [];
    let created = 0;
    let updated = 0;
    const outcomes: SyncOutcomeRecord[] = [];

    for (const record of records) {
      // Find existing live or deleted row
      const existing = await sql`
        SELECT version, record_state, user_pubkey
        FROM ${sql(TABLE)}
        WHERE app_pubkey = ${appPubkey}
          AND record_id = ${record.record_id}
          AND record_state IN ('live', 'deleted')
        ORDER BY version DESC
        LIMIT 1
      `;

      if (existing.length > 0) {
        const row = existing[0];

        // Deleted records are terminal
        if (row.record_state === 'deleted') {
          rejected.push({ record_id: record.record_id, reason: 'record_deleted' });
          continue;
        }

        // Check write permission: owner or app-level delegation
        const recordOwner = row.user_pubkey;
        if (auth.pubkey !== recordOwner) {
          const delegation = await delegationsService.getDelegation(
            appPubkey,
            recordOwner,
            auth.pubkey
          );
          if (!delegation || !delegation.permissions.includes('write')) {
            rejected.push({ record_id: record.record_id, reason: 'no_permission' });
            continue;
          }
        }

        // Atomic CTE: supersede current live row and insert new version
        const result = await sql`
          WITH superseded AS (
            UPDATE ${sql(TABLE)}
            SET record_state = 'superseded'
            WHERE app_pubkey = ${appPubkey}
              AND record_id = ${record.record_id}
              AND record_state = 'live'
            RETURNING version, user_pubkey
          )
          INSERT INTO ${sql(TABLE)} (
            app_pubkey, record_id, user_pubkey, version, record_state,
            collection, encrypted_data, encrypted_from, delegate_payloads
          )
          SELECT
            ${appPubkey},
            ${record.record_id},
            user_pubkey,
            version + 1,
            'live',
            ${record.collection || 'default'},
            ${record.encrypted_data},
            ${record.encrypted_from},
            ${record.delegate_payloads ? sql.json(record.delegate_payloads) : null}
          FROM superseded
          RETURNING version
        `;

        if (result.length > 0) {
          const syncedVersion = result[0].version;
          synced.push({ record_id: record.record_id, version: syncedVersion });
          outcomes.push({
            record_id: record.record_id,
            version: syncedVersion,
            owner_pubkey: recordOwner,
            collection: record.collection || 'default',
          });
          updated++;
        }
      } else {
        // New record — check delegation if owner_pubkey differs from signer
        let recordOwner = auth.pubkey;
        if (record.owner_pubkey && record.owner_pubkey !== auth.pubkey) {
          const delegation = await delegationsService.getDelegation(
            appPubkey,
            record.owner_pubkey,
            auth.pubkey
          );
          if (delegation && delegation.permissions.includes('write')) {
            recordOwner = record.owner_pubkey;
          } else {
            rejected.push({ record_id: record.record_id, reason: 'no_permission' });
            continue;
          }
        }

        const result = await sql`
          INSERT INTO ${sql(TABLE)} (
            app_pubkey, record_id, user_pubkey, version, record_state,
            collection, encrypted_data, encrypted_from, delegate_payloads
          ) VALUES (
            ${appPubkey},
            ${record.record_id},
            ${recordOwner},
            1,
            'live',
            ${record.collection || 'default'},
            ${record.encrypted_data},
            ${record.encrypted_from},
            ${record.delegate_payloads ? sql.json(record.delegate_payloads) : null}
          )
          RETURNING version
        `;

        const syncedVersion = result[0].version;
        synced.push({ record_id: record.record_id, version: syncedVersion });
        outcomes.push({
          record_id: record.record_id,
          version: syncedVersion,
          owner_pubkey: recordOwner,
          collection: record.collection || 'default',
        });
        created++;
      }
    }

    return { synced, created, updated, rejected, outcomes };
  }

  /**
   * Fetch live records owned by the authenticated user.
   * Optional limit/cursor for pagination (used by CVM transport to stay under NIP-44 size limits).
   */
  async fetchRecords(
    appPubkey: string,
    auth: AuthContext,
    collection?: string,
    since?: string,
    limit?: number,
    cursor?: string
  ): Promise<FetchResultV3 & { cursor?: string; has_more?: boolean }> {
    const sql = getDb();

    // cursor acts as an upper bound (records older than cursor), since acts as lower bound
    const fetchLimit = limit ? limit + 1 : undefined; // fetch one extra to detect has_more

    const rows = await sql`
      SELECT record_id, version, collection, encrypted_data, encrypted_from,
             delegate_payloads, created_at
      FROM ${sql(TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND user_pubkey = ${auth.pubkey}
        AND record_state = 'live'
        ${collection ? sql`AND collection = ${collection}` : sql``}
        ${since ? sql`AND created_at > ${since}` : sql``}
        ${cursor ? sql`AND created_at < ${cursor}` : sql``}
      ORDER BY created_at DESC
      ${fetchLimit ? sql`LIMIT ${fetchLimit}` : sql``}
    `;

    const records: RecordOutputV3[] = rows.map((r: any) => {
      const out: RecordOutputV3 = {
        record_id: r.record_id,
        version: r.version,
        collection: r.collection,
        encrypted_data: r.encrypted_data,
        encrypted_from: r.encrypted_from,
        created_at: r.created_at,
      };
      if (r.delegate_payloads && Object.keys(r.delegate_payloads).length > 0) {
        out.delegate_payloads = r.delegate_payloads;
      }
      return out;
    });

    // If we fetched limit+1 and got that many, there are more pages
    const hasMore = limit ? records.length > limit : false;
    if (hasMore) records.pop(); // remove the extra probe record

    const result: FetchResultV3 & { cursor?: string; has_more?: boolean } = { records };
    if (limit) {
      result.has_more = hasMore;
      if (hasMore && records.length > 0) {
        result.cursor = records[records.length - 1].created_at;
      }
    }

    return result;
  }

  /**
   * Fetch records delegated to a specific pubkey.
   * Uses GIN index on delegate_payloads for efficient lookup.
   * Returns only the requesting delegate's payload — strips owner data and other delegates.
   */
  async fetchDelegatedRecords(
    appPubkey: string,
    delegatePubkey: string,
    collection?: string,
    ownerPubkey?: string,
    limit?: number,
    cursor?: string
  ): Promise<DelegatedFetchResultV3 & { cursor?: string; has_more?: boolean }> {
    const sql = getDb();

    const fetchLimit = limit ? limit + 1 : undefined; // fetch one extra to detect has_more

    const rows = await sql`
      SELECT record_id, version, collection, user_pubkey, encrypted_from,
             delegate_payloads, created_at
      FROM ${sql(TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND record_state = 'live'
        AND delegate_payloads ? ${delegatePubkey}
        ${collection ? sql`AND collection = ${collection}` : sql``}
        ${ownerPubkey ? sql`AND user_pubkey = ${ownerPubkey}` : sql``}
        ${cursor ? sql`AND created_at < ${cursor}` : sql``}
      ORDER BY created_at DESC
      ${fetchLimit ? sql`LIMIT ${fetchLimit}` : sql``}
    `;

    const records: DelegatedRecordOutputV3[] = rows.map((r: any) => ({
      record_id: r.record_id,
      version: r.version,
      collection: r.collection,
      owner_pubkey: r.user_pubkey,
      encrypted_from: r.encrypted_from,
      delegate_payload: r.delegate_payloads[delegatePubkey],
      created_at: r.created_at,
    }));

    // If we fetched limit+1 and got that many, there are more pages
    const hasMore = limit ? records.length > limit : false;
    if (hasMore) records.pop();

    const result: DelegatedFetchResultV3 & { cursor?: string; has_more?: boolean } = { records };
    if (limit) {
      result.has_more = hasMore;
      if (hasMore && records.length > 0) {
        result.cursor = records[records.length - 1].created_at;
      }
    }

    return result;
  }

  /**
   * Get full version history for a record
   */
  async getRecordHistory(
    appPubkey: string,
    recordId: string,
    includeData?: boolean
  ): Promise<HistoryResultV3 | null> {
    const sql = getDb();

    const rows = await sql`
      SELECT version, record_state, encrypted_from, created_at,
             user_pubkey
             ${includeData ? sql`, encrypted_data, delegate_payloads` : sql``}
      FROM ${sql(TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND record_id = ${recordId}
      ORDER BY version ASC
    `;

    if (rows.length === 0) return null;

    const versions: HistoryVersionV3[] = rows.map((r: any) => {
      const v: HistoryVersionV3 = {
        version: r.version,
        record_state: r.record_state,
        encrypted_from: r.encrypted_from,
        created_at: r.created_at,
      };
      if (includeData) {
        v.encrypted_data = r.encrypted_data;
        if (r.delegate_payloads) {
          v.delegate_payloads = r.delegate_payloads;
        }
      }
      return v;
    });

    return {
      record_id: recordId,
      owner_pubkey: rows[0].user_pubkey,
      versions,
    };
  }

  /**
   * Delete a record — inserts a terminal "deleted" version
   */
  async deleteRecord(
    appPubkey: string,
    auth: AuthContext,
    recordId: string
  ): Promise<{ version: number } | null> {
    const sql = getDb();

    // Find existing live row
    const existing = await sql`
      SELECT version, record_state, user_pubkey
      FROM ${sql(TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND record_id = ${recordId}
        AND record_state IN ('live', 'deleted')
      ORDER BY version DESC
      LIMIT 1
    `;

    if (existing.length === 0) return null;

    const row = existing[0];
    if (row.record_state === 'deleted') return null;

    // Check ownership
    if (auth.pubkey !== row.user_pubkey) {
      const delegation = await delegationsService.getDelegation(
        appPubkey,
        row.user_pubkey,
        auth.pubkey
      );
      if (!delegation || !delegation.permissions.includes('write')) {
        return null;
      }
    }

    // Atomic CTE: supersede live row and insert deleted version
    const result = await sql`
      WITH superseded AS (
        UPDATE ${sql(TABLE)}
        SET record_state = 'superseded'
        WHERE app_pubkey = ${appPubkey}
          AND record_id = ${recordId}
          AND record_state = 'live'
        RETURNING version, user_pubkey
      )
      INSERT INTO ${sql(TABLE)} (
        app_pubkey, record_id, user_pubkey, version, record_state,
        collection, encrypted_data, encrypted_from, delegate_payloads
      )
      SELECT
        ${appPubkey},
        ${recordId},
        user_pubkey,
        version + 1,
        'deleted',
        'default',
        '',
        '',
        null
      FROM superseded
      RETURNING version
    `;

    if (result.length === 0) return null;
    return { version: result[0].version };
  }
}

// Singleton instance
export const recordsService = new RecordsService();
