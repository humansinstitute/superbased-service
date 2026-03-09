import { getDb } from '../db/postgres';
import { delegationsService } from './delegations';
import { recordGroupAccessService } from './record-group-access';
import type {
  AuthContext,
  SyncRecordInputV3,
  SyncResultV3,
  FetchResultV3,
  ChangesCheckResultV3,
  CollectionChangeSummary,
  RecordOutputV3,
  DelegatedRecordOutputV3,
  DelegatedFetchResultV3,
  HistoryResultV3,
  HistoryVersionV3,
  SyncOutcomeRecord,
} from '../types';

const TABLE = 'superbased_records_v3';
const DELEGATIONS_TABLE = 'superbased_app_delegations';
const RECORD_GROUP_ACCESS_TABLE = 'superbased_record_group_access';
const GROUP_MEMBERS_TABLE = 'superbased_group_members';

/** Safely serialize a Postgres timestamp to ISO string, returning null for invalid dates */
function safeISODate(val: unknown): string | null {
  if (val instanceof Date) {
    return isNaN(val.getTime()) ? null : val.toISOString();
  }
  if (typeof val === 'string') {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

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
        SELECT version, record_state, user_pubkey, collection
        FROM ${sql(TABLE)}
        WHERE app_pubkey = ${appPubkey}
          AND record_id = ${record.record_id}::uuid
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

        // Check write permission: owner, app-level write delegate, or group write member
        const recordOwner = row.user_pubkey;
        if (auth.pubkey !== recordOwner) {
          const delegation = await delegationsService.getDelegation(
            appPubkey,
            recordOwner,
            auth.pubkey
          );
          const delegatedWrite = !!(delegation && delegation.permissions.includes('write'));
          if (!delegatedWrite) {
            const groupWriteGrant = await recordGroupAccessService.getGroupWriteGrantForMember(
              appPubkey,
              row.collection,
              record.record_id,
              auth.pubkey
            );
            if (!groupWriteGrant) {
              rejected.push({ record_id: record.record_id, reason: 'no_permission' });
              continue;
            }
          }
        }

        // Atomic CTE: supersede current live row and insert new version
        const result = await sql`
          WITH superseded AS (
            UPDATE ${sql(TABLE)}
            SET record_state = 'superseded'
            WHERE app_pubkey = ${appPubkey}
              AND record_id = ${record.record_id}::uuid
              AND record_state = 'live'
            RETURNING version, user_pubkey
          )
          INSERT INTO ${sql(TABLE)} (
            app_pubkey, record_id, user_pubkey, version, record_state,
            collection, encrypted_data, encrypted_from, delegate_payloads, group_payloads
          )
          SELECT
            ${appPubkey},
            ${record.record_id}::uuid,
            user_pubkey,
            version + 1,
            'live',
            ${record.collection || 'default'},
            ${record.encrypted_data},
            ${record.encrypted_from},
            ${record.delegate_payloads ? sql.json(record.delegate_payloads) : null},
            ${record.group_payloads ? sql.json(record.group_payloads) : null}
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
            collection, encrypted_data, encrypted_from, delegate_payloads, group_payloads
          ) VALUES (
            ${appPubkey},
            ${record.record_id}::uuid,
            ${recordOwner},
            1,
            'live',
            ${record.collection || 'default'},
            ${record.encrypted_data},
            ${record.encrypted_from},
            ${record.delegate_payloads ? sql.json(record.delegate_payloads) : null},
            ${record.group_payloads ? sql.json(record.group_payloads) : null}
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
             delegate_payloads, group_payloads, created_at::text as created_at
      FROM ${sql(TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND user_pubkey = ${auth.pubkey}
        AND record_state = 'live'
        ${collection ? sql`AND collection = ${collection}` : sql``}
        ${since ? sql`AND created_at > ${since}::timestamptz` : sql``}
        ${cursor ? sql`AND created_at < ${cursor}::timestamptz` : sql``}
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
        created_at: safeISODate(r.created_at),
      };
      if (r.delegate_payloads && Object.keys(r.delegate_payloads).length > 0) {
        out.delegate_payloads = r.delegate_payloads;
      }
      if (r.group_payloads && Object.keys(r.group_payloads).length > 0) {
        out.group_payloads = r.group_payloads;
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
        result.cursor = records[records.length - 1].created_at ?? undefined;
      }
    }

    return result;
  }

  /**
   * Check whether any live records changed by collection since the provided timestamps.
   */
  async checkChanges(
    appPubkey: string,
    auth: AuthContext,
    collections: string[],
    sinceByCollection: Record<string, string> = {}
  ): Promise<ChangesCheckResultV3> {
    const sql = getDb();
    const changes: Record<string, CollectionChangeSummary> = {};
    let changed = false;

    for (const collection of collections) {
      const since = sinceByCollection[collection];
      const rows = await sql`
        SELECT
          COUNT(*)::int as changed_count,
          MAX(created_at)::text as latest_created_at
        FROM ${sql(TABLE)}
        WHERE app_pubkey = ${appPubkey}
          AND record_state = 'live'
          AND collection = ${collection}
          ${since ? sql`AND created_at > ${since}::timestamptz` : sql``}
          AND (
            user_pubkey = ${auth.pubkey}
            OR COALESCE(delegate_payloads, '{}'::jsonb) ? ${auth.pubkey}
            OR EXISTS (
              SELECT 1
              FROM ${sql(RECORD_GROUP_ACCESS_TABLE)} rga
              JOIN ${sql(GROUP_MEMBERS_TABLE)} gm
                ON gm.app_pubkey = rga.app_pubkey
               AND gm.group_id = rga.group_id
               AND gm.member_pubkey = ${auth.pubkey}
               AND gm.revoked_at IS NULL
              WHERE rga.app_pubkey = ${appPubkey}
                AND rga.collection = ${collection}
                AND rga.record_id = ${sql(TABLE)}.record_id
                AND rga.revoked_at IS NULL
                AND rga.can_read = true
                AND COALESCE(${sql(TABLE)}.group_payloads, '{}'::jsonb) ? (rga.group_id::text)
            )
          )
      `;

      const summary: CollectionChangeSummary = {
        changed_count: rows[0]?.changed_count ?? 0,
        latest_created_at: safeISODate(rows[0]?.latest_created_at),
      };
      changes[collection] = summary;
      if (summary.changed_count > 0) changed = true;
    }

    return { changed, changes };
  }

  /**
   * Fetch records accessible to a non-owner:
   * - delegate payload access (legacy/app delegate path)
   * - group payload access (record-level group ACL path)
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
      WITH delegate_matches AS (
        SELECT
          r.record_id,
          r.version,
          r.collection,
          r.user_pubkey,
          r.encrypted_from,
          r.created_at,
          'delegate'::text AS access_mode,
          NULL::text AS group_id,
          (r.delegate_payloads ->> ${delegatePubkey}) AS delegate_payload,
          NULL::text AS group_payload,
          EXISTS (
            SELECT 1
            FROM ${sql(DELEGATIONS_TABLE)} d
            WHERE d.app_pubkey = r.app_pubkey
              AND d.owner_pubkey = r.user_pubkey
              AND d.delegate_pubkey = ${delegatePubkey}
              AND d.revoked_at IS NULL
              AND 'write' = ANY(d.permissions)
          ) AS can_write
        FROM ${sql(TABLE)} r
        WHERE r.app_pubkey = ${appPubkey}
          AND r.record_state = 'live'
          AND r.delegate_payloads ? ${delegatePubkey}
          ${collection ? sql`AND r.collection = ${collection}` : sql``}
          ${ownerPubkey ? sql`AND r.user_pubkey = ${ownerPubkey}` : sql``}
          ${cursor ? sql`AND r.created_at < ${cursor}::timestamptz` : sql``}
      ),
      group_matches_ranked AS (
        SELECT
          r.record_id,
          r.version,
          r.collection,
          r.user_pubkey,
          r.encrypted_from,
          r.created_at,
          'group'::text AS access_mode,
          rga.group_id::text AS group_id,
          NULL::text AS delegate_payload,
          (r.group_payloads ->> (rga.group_id::text)) AS group_payload,
          rga.can_write,
          ROW_NUMBER() OVER (
            PARTITION BY r.record_id
            ORDER BY rga.can_write DESC, rga.updated_at DESC
          ) AS rn
        FROM ${sql(TABLE)} r
        JOIN ${sql(RECORD_GROUP_ACCESS_TABLE)} rga
          ON rga.app_pubkey = r.app_pubkey
         AND rga.collection = r.collection
         AND rga.record_id = r.record_id
         AND rga.revoked_at IS NULL
         AND rga.can_read = true
        JOIN ${sql(GROUP_MEMBERS_TABLE)} gm
          ON gm.app_pubkey = rga.app_pubkey
         AND gm.group_id = rga.group_id
         AND gm.member_pubkey = ${delegatePubkey}
         AND gm.revoked_at IS NULL
        WHERE r.app_pubkey = ${appPubkey}
          AND r.record_state = 'live'
          AND r.group_payloads ? (rga.group_id::text)
          ${collection ? sql`AND r.collection = ${collection}` : sql``}
          ${ownerPubkey ? sql`AND r.user_pubkey = ${ownerPubkey}` : sql``}
          ${cursor ? sql`AND r.created_at < ${cursor}::timestamptz` : sql``}
      ),
      group_matches AS (
        SELECT
          record_id, version, collection, user_pubkey, encrypted_from, created_at,
          access_mode, group_id, delegate_payload, group_payload, can_write
        FROM group_matches_ranked
        WHERE rn = 1
      ),
      combined AS (
        SELECT * FROM delegate_matches
        UNION ALL
        SELECT g.*
        FROM group_matches g
        WHERE NOT EXISTS (
          SELECT 1 FROM delegate_matches d WHERE d.record_id = g.record_id
        )
      )
      SELECT
        record_id,
        version,
        collection,
        user_pubkey,
        encrypted_from,
        access_mode,
        group_id,
        delegate_payload,
        group_payload,
        can_write,
        created_at::text as created_at
      FROM combined
      ORDER BY created_at DESC
      ${fetchLimit ? sql`LIMIT ${fetchLimit}` : sql``}
    `;

    const records: DelegatedRecordOutputV3[] = rows.map((r: any) => {
      const out: DelegatedRecordOutputV3 = {
        record_id: r.record_id,
        version: r.version,
        collection: r.collection,
        owner_pubkey: r.user_pubkey,
        encrypted_from: r.encrypted_from,
        access_mode: r.access_mode === 'group' ? 'group' : 'delegate',
        can_write: r.can_write === true,
        created_at: safeISODate(r.created_at),
      };
      if (out.access_mode === 'group') {
        out.group_id = r.group_id || undefined;
        out.group_payload = r.group_payload || undefined;
      } else {
        out.delegate_payload = r.delegate_payload || undefined;
      }
      return out;
    });

    // If we fetched limit+1 and got that many, there are more pages
    const hasMore = limit ? records.length > limit : false;
    if (hasMore) records.pop();

    const result: DelegatedFetchResultV3 & { cursor?: string; has_more?: boolean } = { records };
    if (limit) {
      result.has_more = hasMore;
      if (hasMore && records.length > 0) {
        result.cursor = records[records.length - 1].created_at ?? undefined;
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
      SELECT version, record_state, encrypted_from, created_at::text as created_at,
             user_pubkey
             ${includeData ? sql`, encrypted_data, delegate_payloads, group_payloads` : sql``}
      FROM ${sql(TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND record_id = ${recordId}::uuid
      ORDER BY version ASC
    `;

    if (rows.length === 0) return null;

    const versions: HistoryVersionV3[] = rows.map((r: any) => {
      const v: HistoryVersionV3 = {
        version: r.version,
        record_state: r.record_state,
        encrypted_from: r.encrypted_from,
        created_at: safeISODate(r.created_at),
      };
      if (includeData) {
        v.encrypted_data = r.encrypted_data;
        if (r.delegate_payloads) {
          v.delegate_payloads = r.delegate_payloads;
        }
        if (r.group_payloads) {
          v.group_payloads = r.group_payloads;
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
      SELECT version, record_state, user_pubkey, collection
      FROM ${sql(TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND record_id = ${recordId}::uuid
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
      const delegatedWrite = !!(delegation && delegation.permissions.includes('write'));
      if (!delegatedWrite) {
        const groupWriteGrant = await recordGroupAccessService.getGroupWriteGrantForMember(
          appPubkey,
          row.collection,
          recordId,
          auth.pubkey
        );
        if (!groupWriteGrant) {
          return null;
        }
      }
    }

    // Atomic CTE: supersede live row and insert deleted version
    const result = await sql`
      WITH superseded AS (
        UPDATE ${sql(TABLE)}
        SET record_state = 'superseded'
        WHERE app_pubkey = ${appPubkey}
          AND record_id = ${recordId}::uuid
          AND record_state = 'live'
        RETURNING version, user_pubkey
      )
      INSERT INTO ${sql(TABLE)} (
        app_pubkey, record_id, user_pubkey, version, record_state,
        collection, encrypted_data, encrypted_from, delegate_payloads, group_payloads
      )
      SELECT
        ${appPubkey},
        ${recordId}::uuid,
        user_pubkey,
        version + 1,
        'deleted',
        'default',
        '',
        '',
        null,
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
