import { nip19 } from 'nostr-tools';
import { getDb } from '../db/postgres';
import type {
  AddGroupMemberInput,
  AuthContext,
  CreateGroupInput,
  CreateGroupRequestInput,
  GroupMember,
  GroupRequest,
  GroupRequestStatus,
  GroupSummary,
  ResolveGroupRequestInput,
} from '../types';

const MEMBERS_TABLE = 'superbased_group_members';
const REQUESTS_TABLE = 'superbased_group_requests';

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

function decodeNpub(npub: string): string {
  try {
    const decoded = nip19.decode(npub);
    if (decoded.type !== 'npub') {
      throw new Error('must be npub');
    }
    return decoded.data as string;
  } catch (err) {
    throw new Error(`Invalid npub: ${err}`);
  }
}

function normalizeRole(role?: string): 'admin' | 'member' | 'pending' {
  if (!role) return 'member';
  if (role === 'admin' || role === 'member' || role === 'pending') return role;
  throw new Error(`Invalid role: ${role}`);
}

function normalizeStatus(status?: string): GroupRequestStatus | undefined {
  if (!status) return undefined;
  if (status === 'pending' || status === 'approved' || status === 'rejected' || status === 'expired') {
    return status;
  }
  throw new Error(`Invalid status: ${status}`);
}

export class GroupsService {
  private async getGroupSeed(appPubkey: string, groupId: string): Promise<GroupMember | null> {
    const sql = getDb();
    const rows = await sql`
      SELECT id, app_pubkey, group_id::text as group_id, group_name, group_pubkey, owner_pubkey,
             member_pubkey, encrypted_group_key, role, invited_by,
             joined_at::text as joined_at, created_at::text as created_at,
             updated_at::text as updated_at, revoked_at::text as revoked_at
      FROM ${sql(MEMBERS_TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND group_id = ${groupId}::uuid
        AND revoked_at IS NULL
      ORDER BY CASE WHEN role = 'owner' THEN 0 ELSE 1 END, created_at ASC
      LIMIT 1
    `;

    if (rows.length === 0) return null;
    return rows[0] as unknown as GroupMember;
  }

  private async getActiveMembership(
    appPubkey: string,
    groupId: string,
    memberPubkey: string
  ): Promise<GroupMember | null> {
    const sql = getDb();
    const rows = await sql`
      SELECT id, app_pubkey, group_id::text as group_id, group_name, group_pubkey, owner_pubkey,
             member_pubkey, encrypted_group_key, role, invited_by,
             joined_at::text as joined_at, created_at::text as created_at,
             updated_at::text as updated_at, revoked_at::text as revoked_at
      FROM ${sql(MEMBERS_TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND group_id = ${groupId}::uuid
        AND member_pubkey = ${memberPubkey}
        AND revoked_at IS NULL
      LIMIT 1
    `;
    return rows.length > 0 ? (rows[0] as unknown as GroupMember) : null;
  }

  private async requireGroupMember(appPubkey: string, groupId: string, memberPubkey: string): Promise<GroupMember> {
    const membership = await this.getActiveMembership(appPubkey, groupId, memberPubkey);
    if (!membership) {
      throw new Error('Group membership required');
    }
    return membership;
  }

  private async requireGroupAdmin(appPubkey: string, groupId: string, memberPubkey: string): Promise<GroupMember> {
    const membership = await this.requireGroupMember(appPubkey, groupId, memberPubkey);
    if (membership.role !== 'owner' && membership.role !== 'admin') {
      throw new Error('Admin role required');
    }
    return membership;
  }

  async createGroup(appPubkey: string, auth: AuthContext, input: CreateGroupInput): Promise<GroupSummary> {
    if (!input.group_name?.trim()) {
      throw new Error('group_name is required');
    }
    if (!input.group_pubkey?.trim()) {
      throw new Error('group_pubkey is required');
    }
    if (!input.encrypted_group_key?.trim()) {
      throw new Error('encrypted_group_key is required');
    }

    const groupId = crypto.randomUUID();
    const sql = getDb();

    await sql`
      INSERT INTO ${sql(MEMBERS_TABLE)} (
        app_pubkey, group_id, group_name, group_pubkey, owner_pubkey,
        member_pubkey, encrypted_group_key, role, invited_by, joined_at
      ) VALUES (
        ${appPubkey}, ${groupId}::uuid, ${input.group_name.trim()}, ${input.group_pubkey.trim()},
        ${auth.pubkey}, ${auth.pubkey}, ${input.encrypted_group_key.trim()}, 'owner', NULL, now()
      )
    `;

    return {
      group_id: groupId,
      group_name: input.group_name.trim(),
      group_pubkey: input.group_pubkey.trim(),
      owner_pubkey: auth.pubkey,
      my_role: 'owner',
      joined_at: new Date().toISOString(),
    };
  }

  async listMyGroups(appPubkey: string, auth: AuthContext): Promise<GroupSummary[]> {
    const sql = getDb();
    const rows = await sql`
      SELECT group_id::text as group_id, group_name, group_pubkey, owner_pubkey, role,
             joined_at::text as joined_at
      FROM ${sql(MEMBERS_TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND member_pubkey = ${auth.pubkey}
        AND revoked_at IS NULL
      ORDER BY updated_at DESC
    `;

    return rows.map((r: any) => ({
      group_id: r.group_id,
      group_name: r.group_name,
      group_pubkey: r.group_pubkey,
      owner_pubkey: r.owner_pubkey,
      my_role: r.role,
      joined_at: safeISODate(r.joined_at),
    }));
  }

  async listGroupMembers(appPubkey: string, auth: AuthContext, groupId: string): Promise<GroupMember[]> {
    await this.requireGroupMember(appPubkey, groupId, auth.pubkey);
    const sql = getDb();
    const rows = await sql`
      SELECT id, app_pubkey, group_id::text as group_id, group_name, group_pubkey, owner_pubkey,
             member_pubkey, encrypted_group_key, role, invited_by,
             joined_at::text as joined_at, created_at::text as created_at,
             updated_at::text as updated_at, revoked_at::text as revoked_at
      FROM ${sql(MEMBERS_TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND group_id = ${groupId}::uuid
        AND revoked_at IS NULL
      ORDER BY
        CASE role
          WHEN 'owner' THEN 0
          WHEN 'admin' THEN 1
          WHEN 'member' THEN 2
          ELSE 3
        END,
        created_at ASC
    `;

    return rows as unknown as GroupMember[];
  }

  async addMember(
    appPubkey: string,
    auth: AuthContext,
    groupId: string,
    input: AddGroupMemberInput
  ): Promise<{ member: GroupMember; created: boolean }> {
    await this.requireGroupAdmin(appPubkey, groupId, auth.pubkey);

    if (!input.encrypted_group_key?.trim()) {
      throw new Error('encrypted_group_key is required');
    }

    const role = normalizeRole(input.role);
    const memberPubkey = decodeNpub(input.member_npub);
    const seed = await this.getGroupSeed(appPubkey, groupId);
    if (!seed) {
      throw new Error('Group not found');
    }

    const sql = getDb();
    const existing = await this.getActiveMembership(appPubkey, groupId, memberPubkey);

    if (existing) {
      const updated = await sql`
        UPDATE ${sql(MEMBERS_TABLE)}
        SET encrypted_group_key = ${input.encrypted_group_key.trim()},
            role = ${role},
            invited_by = ${auth.pubkey},
            group_name = ${seed.group_name},
            group_pubkey = ${seed.group_pubkey},
            owner_pubkey = ${seed.owner_pubkey},
            joined_at = COALESCE(joined_at, now()),
            revoked_at = NULL,
            updated_at = now()
        WHERE id = ${existing.id}::uuid
        RETURNING id, app_pubkey, group_id::text as group_id, group_name, group_pubkey, owner_pubkey,
                  member_pubkey, encrypted_group_key, role, invited_by,
                  joined_at::text as joined_at, created_at::text as created_at,
                  updated_at::text as updated_at, revoked_at::text as revoked_at
      `;
      return { member: updated[0] as unknown as GroupMember, created: false };
    }

    const inserted = await sql`
      INSERT INTO ${sql(MEMBERS_TABLE)} (
        app_pubkey, group_id, group_name, group_pubkey, owner_pubkey,
        member_pubkey, encrypted_group_key, role, invited_by, joined_at
      ) VALUES (
        ${appPubkey}, ${groupId}::uuid, ${seed.group_name}, ${seed.group_pubkey}, ${seed.owner_pubkey},
        ${memberPubkey}, ${input.encrypted_group_key.trim()}, ${role}, ${auth.pubkey}, now()
      )
      RETURNING id, app_pubkey, group_id::text as group_id, group_name, group_pubkey, owner_pubkey,
                member_pubkey, encrypted_group_key, role, invited_by,
                joined_at::text as joined_at, created_at::text as created_at,
                updated_at::text as updated_at, revoked_at::text as revoked_at
    `;

    return { member: inserted[0] as unknown as GroupMember, created: true };
  }

  async removeMember(appPubkey: string, auth: AuthContext, groupId: string, memberNpub: string): Promise<boolean> {
    await this.requireGroupAdmin(appPubkey, groupId, auth.pubkey);

    const memberPubkey = decodeNpub(memberNpub);
    const sql = getDb();
    const result = await sql`
      UPDATE ${sql(MEMBERS_TABLE)}
      SET revoked_at = now(),
          updated_at = now()
      WHERE app_pubkey = ${appPubkey}
        AND group_id = ${groupId}::uuid
        AND member_pubkey = ${memberPubkey}
        AND revoked_at IS NULL
        AND role <> 'owner'
    `;
    return result.count > 0;
  }

  async createJoinRequest(
    appPubkey: string,
    auth: AuthContext,
    groupId: string,
    input: CreateGroupRequestInput
  ): Promise<{ request: GroupRequest; created: boolean }> {
    if (!input.invite_secret?.trim()) {
      throw new Error('invite_secret is required');
    }

    const seed = await this.getGroupSeed(appPubkey, groupId);
    if (!seed) {
      throw new Error('Group not found');
    }

    const sql = getDb();
    const existing = await sql`
      SELECT id
      FROM ${sql(REQUESTS_TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND group_id = ${groupId}::uuid
        AND requester_pubkey = ${auth.pubkey}
        AND status = 'pending'
      LIMIT 1
    `;

    if (existing.length > 0) {
      const updated = await sql`
        UPDATE ${sql(REQUESTS_TABLE)}
        SET invite_secret = ${input.invite_secret.trim()},
            updated_at = now(),
            resolved_at = NULL
        WHERE id = ${existing[0].id}::uuid
        RETURNING id, app_pubkey, group_id::text as group_id, requester_pubkey, invite_secret, status,
                  created_at::text as created_at, updated_at::text as updated_at, resolved_at::text as resolved_at
      `;
      return { request: updated[0] as unknown as GroupRequest, created: false };
    }

    const inserted = await sql`
      INSERT INTO ${sql(REQUESTS_TABLE)} (
        app_pubkey, group_id, requester_pubkey, invite_secret, status
      ) VALUES (
        ${appPubkey}, ${groupId}::uuid, ${auth.pubkey}, ${input.invite_secret.trim()}, 'pending'
      )
      RETURNING id, app_pubkey, group_id::text as group_id, requester_pubkey, invite_secret, status,
                created_at::text as created_at, updated_at::text as updated_at, resolved_at::text as resolved_at
    `;
    return { request: inserted[0] as unknown as GroupRequest, created: true };
  }

  async listJoinRequests(
    appPubkey: string,
    auth: AuthContext,
    groupId: string,
    status?: string
  ): Promise<GroupRequest[]> {
    await this.requireGroupAdmin(appPubkey, groupId, auth.pubkey);
    const resolvedStatus = normalizeStatus(status);
    const sql = getDb();
    const rows = await sql`
      SELECT id, app_pubkey, group_id::text as group_id, requester_pubkey, invite_secret, status,
             created_at::text as created_at, updated_at::text as updated_at, resolved_at::text as resolved_at
      FROM ${sql(REQUESTS_TABLE)}
      WHERE app_pubkey = ${appPubkey}
        AND group_id = ${groupId}::uuid
        ${resolvedStatus ? sql`AND status = ${resolvedStatus}` : sql``}
      ORDER BY created_at DESC
    `;
    return rows as unknown as GroupRequest[];
  }

  async resolveJoinRequest(
    appPubkey: string,
    auth: AuthContext,
    groupId: string,
    requestId: string,
    input: ResolveGroupRequestInput
  ): Promise<{ request: GroupRequest; member?: GroupMember }> {
    await this.requireGroupAdmin(appPubkey, groupId, auth.pubkey);

    if (input.status === 'approved' && !input.member_encrypted_group_key?.trim()) {
      throw new Error('member_encrypted_group_key is required when approving');
    }

    const sql = getDb();
    const rows = await sql`
      SELECT id, app_pubkey, group_id::text as group_id, requester_pubkey, invite_secret, status,
             created_at::text as created_at, updated_at::text as updated_at, resolved_at::text as resolved_at
      FROM ${sql(REQUESTS_TABLE)}
      WHERE id = ${requestId}::uuid
        AND app_pubkey = ${appPubkey}
        AND group_id = ${groupId}::uuid
      LIMIT 1
    `;

    if (rows.length === 0) {
      throw new Error('Request not found');
    }

    const existing = rows[0] as unknown as GroupRequest;
    if (existing.status !== 'pending') {
      throw new Error('Only pending requests can be resolved');
    }

    const updated = await sql`
      UPDATE ${sql(REQUESTS_TABLE)}
      SET status = ${input.status},
          updated_at = now(),
          resolved_at = now()
      WHERE id = ${requestId}::uuid
      RETURNING id, app_pubkey, group_id::text as group_id, requester_pubkey, invite_secret, status,
                created_at::text as created_at, updated_at::text as updated_at, resolved_at::text as resolved_at
    `;

    const request = updated[0] as unknown as GroupRequest;

    if (input.status !== 'approved') {
      return { request };
    }

    const role = normalizeRole(input.role);
    const seed = await this.getGroupSeed(appPubkey, groupId);
    if (!seed) {
      throw new Error('Group not found');
    }

    const activeMembership = await this.getActiveMembership(appPubkey, groupId, request.requester_pubkey);
    if (activeMembership) {
      const refreshed = await sql`
        UPDATE ${sql(MEMBERS_TABLE)}
        SET encrypted_group_key = ${input.member_encrypted_group_key!.trim()},
            role = ${role},
            invited_by = ${auth.pubkey},
            group_name = ${seed.group_name},
            group_pubkey = ${seed.group_pubkey},
            owner_pubkey = ${seed.owner_pubkey},
            joined_at = COALESCE(joined_at, now()),
            revoked_at = NULL,
            updated_at = now()
        WHERE id = ${activeMembership.id}::uuid
        RETURNING id, app_pubkey, group_id::text as group_id, group_name, group_pubkey, owner_pubkey,
                  member_pubkey, encrypted_group_key, role, invited_by,
                  joined_at::text as joined_at, created_at::text as created_at,
                  updated_at::text as updated_at, revoked_at::text as revoked_at
      `;
      return { request, member: refreshed[0] as unknown as GroupMember };
    }

    const inserted = await sql`
      INSERT INTO ${sql(MEMBERS_TABLE)} (
        app_pubkey, group_id, group_name, group_pubkey, owner_pubkey,
        member_pubkey, encrypted_group_key, role, invited_by, joined_at
      ) VALUES (
        ${appPubkey}, ${groupId}::uuid, ${seed.group_name}, ${seed.group_pubkey}, ${seed.owner_pubkey},
        ${request.requester_pubkey}, ${input.member_encrypted_group_key!.trim()}, ${role}, ${auth.pubkey}, now()
      )
      RETURNING id, app_pubkey, group_id::text as group_id, group_name, group_pubkey, owner_pubkey,
                member_pubkey, encrypted_group_key, role, invited_by,
                joined_at::text as joined_at, created_at::text as created_at,
                updated_at::text as updated_at, revoked_at::text as revoked_at
    `;

    return { request, member: inserted[0] as unknown as GroupMember };
  }
}

export const groupsService = new GroupsService();
