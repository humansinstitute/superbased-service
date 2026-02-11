import { FluxbaseClient } from '../fluxbase/client';
import { getConfig } from '../config';
import { delegationsService } from './delegations';
import type {
  AuthContext,
  SyncRecordInput,
  SyncResult,
  FetchResult,
  RecordOutput,
  DelegatedRecordOutput,
  DelegatedFetchResult,
  DelegatedFetchParams,
} from '../types';

// Shared table for all app records
const RECORDS_TABLE = 'superbased_records_v2';

/**
 * Service for syncing and fetching encrypted records
 */
export class RecordsService {
  /**
   * Sync records (upsert) to shared records table
   * Includes permission checking for delegated writes
   */
  async syncRecords(
    appPubkey: string,
    auth: AuthContext,
    records: SyncRecordInput[]
  ): Promise<SyncResult> {
    const config = getConfig();
    // Use service key for record operations
    const client = new FluxbaseClient(config.fluxbaseServiceKey);

    let created = 0;
    let updated = 0;
    let denied = 0;

    for (const record of records) {
      // Check if record exists (could be owned by signer or someone else)
      const existing = await client.query({
        table: RECORDS_TABLE,
        filter: {
          app_pubkey: appPubkey,
          record_id: record.record_id,
        },
        limit: 1,
      });

      if (existing.data?.length) {
        const existingRecord = existing.data[0] as any;
        const recordOwner = existingRecord.user_pubkey;

        // Check write permission (includes DER v1 write_delegates check)
        const assignedTo = (existingRecord.metadata?.assigned_to as string) ||
                          (record.metadata?.assigned_to as string);
        const writeDelegates = (existingRecord.metadata?.write_delegates as string[]) || [];
        const permission = await delegationsService.checkWritePermission(
          appPubkey,
          auth.pubkey,
          recordOwner,
          assignedTo,
          writeDelegates
        );

        if (!permission.allowed) {
          denied++;
          continue;
        }

        // Update existing record (keep original owner)
        const updateData: Record<string, unknown> = {
          encrypted_data: record.encrypted_data,
          collection: record.collection || 'default',
          metadata: record.metadata || {},
          updated_at: new Date().toISOString(),
        };

        // DER v1: delegate_payloads map format (preferred)
        if ((record as any).delegate_payloads && Object.keys((record as any).delegate_payloads).length > 0) {
          updateData.delegate_payloads = (record as any).delegate_payloads;
        }

        // Legacy v0: delegates array format
        if (record.delegates && record.delegates.length > 0) {
          updateData.delegates = record.delegates;
        }

        const updateResult = await client.update({
          table: RECORDS_TABLE,
          filter: {
            app_pubkey: appPubkey,
            record_id: record.record_id,
          },
          data: updateData,
        });

        if (updateResult.error) {
          console.error(`[records] update failed for ${record.record_id}:`, updateResult.error);
        } else {
          updated++;
        }
      } else {
        // Insert new record
        // If owner_pubkey is provided and differs from signer, check app-level delegation
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
            denied++;
            continue;
          }
        }

        const insertData: Record<string, unknown> = {
          app_pubkey: appPubkey,
          user_pubkey: recordOwner,
          record_id: record.record_id,
          collection: record.collection || 'default',
          encrypted_data: record.encrypted_data,
          metadata: record.metadata || {},
        };

        // DER v1: delegate_payloads map format (preferred)
        if ((record as any).delegate_payloads && Object.keys((record as any).delegate_payloads).length > 0) {
          insertData.delegate_payloads = (record as any).delegate_payloads;
        }

        // Legacy v0: delegates array format
        if (record.delegates && record.delegates.length > 0) {
          insertData.delegates = record.delegates;
        }

        const insertResult = await client.insert({
          table: RECORDS_TABLE,
          data: insertData,
        });

        if (insertResult.error) {
          console.error(`[records] insert failed for ${record.record_id}:`, insertResult.error);
        } else {
          created++;
        }
      }
    }

    const result: SyncResult = { synced_count: created + updated, created, updated };
    if (denied > 0) {
      result.denied = denied;
    }
    return result;
  }

  /**
   * Fetch records with optional filters
   */
  async fetchRecords(
    appPubkey: string,
    auth: AuthContext,
    collection?: string,
    since?: string
  ): Promise<FetchResult> {
    const config = getConfig();
    const client = new FluxbaseClient(config.fluxbaseServiceKey);

    const filter: Record<string, unknown> = {
      app_pubkey: appPubkey,
      user_pubkey: auth.pubkey,
    };

    if (collection) {
      filter.collection = collection;
    }

    if (since) {
      filter.updated_at = { gt: since };
    }

    const result = await client.query({
      table: RECORDS_TABLE,
      filter,
      order: { column: 'updated_at', ascending: false },
    });

    if (result.error) {
      throw new Error(result.error);
    }

    const records: RecordOutput[] = (result.data || []).map((r: any) => {
      const output: RecordOutput = {
        record_id: r.record_id,
        collection: r.collection,
        encrypted_data: r.encrypted_data,
        metadata: r.metadata,
        updated_at: r.updated_at,
      };
      if (r.delegates && r.delegates.length > 0) {
        output.delegates = r.delegates;
      }
      return output;
    });

    return { records };
  }

  /**
   * Fetch records as a delegate
   * Returns records from owners who have granted read access
   * AND records assigned to the delegate
   */
  async fetchRecordsForDelegate(
    appPubkey: string,
    delegatePubkey: string,
    collection?: string,
    since?: string
  ): Promise<FetchResult> {
    const config = getConfig();
    const client = new FluxbaseClient(config.fluxbaseServiceKey);

    // Get all owners who have granted read access to this delegate
    const ownersWithReadAccess = await delegationsService.getOwnersWithReadAccess(
      appPubkey,
      delegatePubkey
    );

    const allRecords: RecordOutput[] = [];

    // Fetch records from each owner with read delegation
    for (const ownerPubkey of ownersWithReadAccess) {
      const filter: Record<string, unknown> = {
        app_pubkey: appPubkey,
        user_pubkey: ownerPubkey,
      };

      if (collection) {
        filter.collection = collection;
      }

      if (since) {
        filter.updated_at = { gt: since };
      }

      const result = await client.query({
        table: RECORDS_TABLE,
        filter,
        order: { column: 'updated_at', ascending: false },
      });

      if (!result.error && result.data) {
        const records = (result.data as any[]).map((r: any) => {
          const output: RecordOutput = {
            record_id: r.record_id,
            collection: r.collection,
            encrypted_data: r.encrypted_data,
            metadata: r.metadata,
            updated_at: r.updated_at,
            owner_pubkey: r.user_pubkey,
          };
          if (r.delegates && r.delegates.length > 0) {
            output.delegates = r.delegates;
          }
          return output;
        });
        allRecords.push(...records);
      }
    }

    // Also fetch records assigned specifically to this delegate
    // Using raw SQL through the API is complex, so we'll fetch and filter
    // This is a simplified approach - in production you'd want a proper query
    const assignedResult = await client.query({
      table: RECORDS_TABLE,
      filter: {
        app_pubkey: appPubkey,
      },
      order: { column: 'updated_at', ascending: false },
    });

    if (!assignedResult.error && assignedResult.data) {
      for (const r of assignedResult.data as any[]) {
        // Check if assigned to this delegate
        const assignedTo = r.metadata?.assigned_to as string;
        if (assignedTo === delegatePubkey) {
          // Don't duplicate records already fetched via read delegation
          const alreadyIncluded = allRecords.some(
            existing => existing.record_id === r.record_id
          );
          if (!alreadyIncluded) {
            // Apply collection filter if specified
            if (collection && r.collection !== collection) {
              continue;
            }
            // Apply since filter if specified
            if (since && r.updated_at <= since) {
              continue;
            }

            const output: RecordOutput = {
              record_id: r.record_id,
              collection: r.collection,
              encrypted_data: r.encrypted_data,
              metadata: r.metadata,
              updated_at: r.updated_at,
              owner_pubkey: r.user_pubkey,
            };
            if (r.delegates && r.delegates.length > 0) {
              output.delegates = r.delegates;
            }
            allRecords.push(output);
          }
        }
      }
    }

    // Sort by updated_at descending
    allRecords.sort((a, b) =>
      new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );

    return { records: allRecords };
  }

  /**
   * Fetch records delegated to a specific pubkey (DER pull endpoint).
   *
   * Finds records where the delegate's pubkey appears in
   * metadata.read_delegates or metadata.write_delegates.
   *
   * Privacy guarantees:
   * - encrypted_data (owner's blob) is never returned
   * - Only the requesting delegate's entry from delegate_payloads is returned
   * - Other delegates' blobs are stripped
   */
  async fetchDelegatedRecords(
    appPubkey: string,
    delegatePubkey: string,
    params: DelegatedFetchParams
  ): Promise<DelegatedFetchResult> {
    const config = getConfig();
    const client = new FluxbaseClient(config.fluxbaseServiceKey);

    const { since, collection, limit = 100, cursor } = params;

    // Build base filter for app
    const filter: Record<string, unknown> = {
      app_pubkey: appPubkey,
    };

    if (collection) {
      filter.collection = collection;
    }

    if (since) {
      filter.updated_at = { gt: since };
    }

    // If cursor is provided, use it as an offset-based pagination token
    // Cursor format: "offset:<number>"
    let offset = 0;
    if (cursor) {
      const parts = cursor.split(':');
      if (parts[0] === 'offset' && parts[1]) {
        offset = parseInt(parts[1], 10);
      }
    }

    // Fetch records for this app — we filter delegate membership in JS
    // because JSONB array containment queries aren't available through
    // the simple PostgREST-style filter API
    const result = await client.query({
      table: RECORDS_TABLE,
      filter,
      order: { column: 'updated_at', ascending: false },
    });

    if (result.error) {
      throw new Error(result.error);
    }

    const allRecords = (result.data || []) as any[];
    const matchingRecords: DelegatedRecordOutput[] = [];

    for (const r of allRecords) {
      const metadata = r.metadata || {};
      const readDelegates: string[] = metadata.read_delegates || [];
      const writeDelegates: string[] = metadata.write_delegates || [];

      const isReadDelegate = readDelegates.includes(delegatePubkey);
      const isWriteDelegate = writeDelegates.includes(delegatePubkey);

      if (!isReadDelegate && !isWriteDelegate) {
        continue;
      }

      // Extract only this delegate's payload
      let delegatePayload: string | null = null;

      // Check DER v1 map format first
      if (r.delegate_payloads && typeof r.delegate_payloads === 'object') {
        delegatePayload = r.delegate_payloads[delegatePubkey] || null;
      }

      // Fall back to legacy v0 array format
      if (!delegatePayload && Array.isArray(r.delegates)) {
        const entry = r.delegates.find(
          (d: any) => d.delegate_pubkey === delegatePubkey
        );
        if (entry) {
          delegatePayload = entry.encrypted_blob;
        }
      }

      // Skip records where the delegate has no encrypted blob available
      if (!delegatePayload) {
        continue;
      }

      matchingRecords.push({
        record_id: r.record_id,
        collection: r.collection,
        owner_pubkey: r.user_pubkey,
        access: isWriteDelegate ? 'write' : 'read',
        metadata,
        delegate_payload: delegatePayload,
        updated_at: r.updated_at,
      });
    }

    // Apply offset + limit pagination
    const page = matchingRecords.slice(offset, offset + limit);
    const hasMore = offset + limit < matchingRecords.length;
    const nextCursor = hasMore ? `offset:${offset + limit}` : null;

    return {
      records: page,
      cursor: nextCursor,
    };
  }

  /**
   * Delete records by ID
   */
  async deleteRecords(
    appPubkey: string,
    auth: AuthContext,
    recordIds: string[]
  ): Promise<number> {
    const config = getConfig();
    const client = new FluxbaseClient(config.fluxbaseServiceKey);
    let deleted = 0;

    for (const recordId of recordIds) {
      const result = await client.delete({
        table: RECORDS_TABLE,
        filter: {
          app_pubkey: appPubkey,
          user_pubkey: auth.pubkey,
          record_id: recordId,
        },
      });
      if (!result.error) deleted++;
    }

    return deleted;
  }
}

// Singleton instance
export const recordsService = new RecordsService();
