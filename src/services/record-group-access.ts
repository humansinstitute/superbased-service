import { getDb } from '../db/postgres';
import { delegationsService } from './delegations';
import type { AuthContext } from '../types';

const TABLE = 'superbased_record_group_access';
const RECORDS_TABLE = 'superbased_records_v3';
const MEMBERS_TABLE = 'superbased_group_members';

export interface RecordGroupAccessRow {
  id: string;
  app_pubkey: string;
  collection: string;
  record_id: string;
  group_id: string;
  can_read: boolean;
  can_write: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  revoked_at?: string | null;
}

interface RecordOwnerRow {
  user_pubkey: string;
  collection: string;
}

export class RecordGroupAccessService {
  private async getLiveRecordOwner(appPubkey: string, recordId: string): Promise<RecordOwnerRow | null> {
    const sql = getDb();
    const rows = await sql`
      SELECT user_pubkey, collection
      FROM ${sql(RECORDS_TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND record_id = ${recordId}::uuid
        AND record_state = 'live'
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    return rows[0] as unknown as RecordOwnerRow;
  }

  private async canManageRecordAccess(appPubkey: string, authPubkey: string, ownerPubkey: string): Promise<boolean> {
    if (authPubkey === ownerPubkey) return true;
    const delegation = await delegationsService.getDelegation(appPubkey, ownerPubkey, authPubkey);
    return !!(delegation && delegation.permissions.includes('write'));
  }

  async upsertGroupAccess(
    appPubkey: string,
    auth: AuthContext,
    input: {
      collection: string;
      record_id: string;
      group_id: string;
      can_read: boolean;
      can_write: boolean;
    }
  ): Promise<RecordGroupAccessRow> {
    const collection = String(input.collection || 'default').trim();
    const recordId = String(input.record_id || '').trim();
    const groupId = String(input.group_id || '').trim();
    const canWrite = input.can_write === true;
    const canRead = canWrite ? true : input.can_read === true;

    if (!collection) throw new Error('collection is required');
    if (!recordId) throw new Error('record_id is required');
    if (!groupId) throw new Error('group_id is required');

    const owner = await this.getLiveRecordOwner(appPubkey, recordId);
    if (!owner) throw new Error('Record not found');
    if (owner.collection !== collection) throw new Error('Collection mismatch for record');

    const allowed = await this.canManageRecordAccess(appPubkey, auth.pubkey, owner.user_pubkey);
    if (!allowed) throw new Error('Only owner or write delegate can manage record group access');

    const sql = getDb();
    const updated = await sql`
      UPDATE ${sql(TABLE)}
      SET can_read = ${canRead},
          can_write = ${canWrite},
          revoked_at = NULL,
          updated_at = now()
      WHERE app_pubkey = ${appPubkey}
        AND collection = ${collection}
        AND record_id = ${recordId}::uuid
        AND group_id = ${groupId}::uuid
        AND revoked_at IS NULL
      RETURNING id, app_pubkey, collection, record_id, group_id::text as group_id,
                can_read, can_write, created_by,
                created_at::text as created_at, updated_at::text as updated_at,
                revoked_at::text as revoked_at
    `;
    if (updated.length > 0) {
      return updated[0] as unknown as RecordGroupAccessRow;
    }

    const inserted = await sql`
      INSERT INTO ${sql(TABLE)} (
        app_pubkey, collection, record_id, group_id,
        can_read, can_write, created_by
      ) VALUES (
        ${appPubkey}, ${collection}, ${recordId}::uuid, ${groupId}::uuid,
        ${canRead}, ${canWrite}, ${auth.pubkey}
      )
      RETURNING id, app_pubkey, collection, record_id, group_id::text as group_id,
                can_read, can_write, created_by,
                created_at::text as created_at, updated_at::text as updated_at,
                revoked_at::text as revoked_at
    `;
    return inserted[0] as unknown as RecordGroupAccessRow;
  }

  async revokeGroupAccess(
    appPubkey: string,
    auth: AuthContext,
    collection: string,
    recordId: string,
    groupId: string
  ): Promise<boolean> {
    const owner = await this.getLiveRecordOwner(appPubkey, recordId);
    if (!owner) throw new Error('Record not found');
    if (owner.collection !== collection) throw new Error('Collection mismatch for record');

    const allowed = await this.canManageRecordAccess(appPubkey, auth.pubkey, owner.user_pubkey);
    if (!allowed) throw new Error('Only owner or write delegate can manage record group access');

    const sql = getDb();
    const result = await sql`
      UPDATE ${sql(TABLE)}
      SET revoked_at = now(), updated_at = now()
      WHERE app_pubkey = ${appPubkey}
        AND collection = ${collection}
        AND record_id = ${recordId}::uuid
        AND group_id = ${groupId}::uuid
        AND revoked_at IS NULL
    `;
    return result.count > 0;
  }

  async listGroupAccess(
    appPubkey: string,
    auth: AuthContext,
    collection: string,
    recordId: string
  ): Promise<RecordGroupAccessRow[]> {
    const owner = await this.getLiveRecordOwner(appPubkey, recordId);
    if (!owner) throw new Error('Record not found');
    if (owner.collection !== collection) throw new Error('Collection mismatch for record');

    const allowed = await this.canManageRecordAccess(appPubkey, auth.pubkey, owner.user_pubkey);
    if (!allowed) throw new Error('Only owner or write delegate can list record group access');

    const sql = getDb();
    const rows = await sql`
      SELECT id, app_pubkey, collection, record_id, group_id::text as group_id,
             can_read, can_write, created_by,
             created_at::text as created_at, updated_at::text as updated_at,
             revoked_at::text as revoked_at
      FROM ${sql(TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND collection = ${collection}
        AND record_id = ${recordId}::uuid
        AND revoked_at IS NULL
      ORDER BY updated_at DESC
    `;
    return rows as unknown as RecordGroupAccessRow[];
  }

  async getGroupWriteGrantForMember(
    appPubkey: string,
    collection: string,
    recordId: string,
    memberPubkey: string
  ): Promise<{ group_id: string; can_write: boolean } | null> {
    const sql = getDb();
    const rows = await sql`
      SELECT rga.group_id::text as group_id, rga.can_write
      FROM ${sql(TABLE)} rga
      JOIN ${sql(MEMBERS_TABLE)} gm
        ON gm.app_pubkey = rga.app_pubkey
       AND gm.group_id = rga.group_id
       AND gm.member_pubkey = ${memberPubkey}
       AND gm.revoked_at IS NULL
      WHERE rga.app_pubkey = ${appPubkey}
        AND rga.collection = ${collection}
        AND rga.record_id = ${recordId}::uuid
        AND rga.revoked_at IS NULL
        AND rga.can_write = true
      ORDER BY rga.updated_at DESC
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    return rows[0] as { group_id: string; can_write: boolean };
  }
}

export const recordGroupAccessService = new RecordGroupAccessService();
