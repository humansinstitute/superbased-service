/**
 * Integration tests for GroupsService.
 *
 * Run: bun test src/__tests__/groups-service.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { nip19 } from 'nostr-tools';
import { getDb, closeDb } from '../db/postgres';
import { GroupsService } from '../services/groups';
import type { AuthContext } from '../types';

const MEMBERS_TABLE = 'superbased_group_members';
const REQUESTS_TABLE = 'superbased_group_requests';
const GROUPS_TABLE = 'superbased_groups';
const TEST_RUN_ID = process.env.FLUX_TEST_RUN_ID || 'local';
const APP = `test_groups_app_${TEST_RUN_ID}`;

const OWNER_PK = 'aaaa'.repeat(16);
const ADMIN_PK = 'bbbb'.repeat(16);
const MEMBER_PK = 'cccc'.repeat(16);
const OTHER_PK = 'dddd'.repeat(16);

function auth(pubkey: string): AuthContext {
  return { pubkey, npub: `npub_${pubkey.slice(0, 8)}`, isAdmin: false };
}

function npub(hexPubkey: string): string {
  return nip19.npubEncode(hexPubkey);
}

let service: GroupsService;

beforeAll(async () => {
  const sql = getDb();

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql(GROUPS_TABLE)} (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      app_pubkey      text NOT NULL,
      group_id        uuid NOT NULL,
      group_name      text NOT NULL,
      group_pubkey    text NOT NULL,
      owner_pubkey    text NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      archived_at     timestamptz
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql(MEMBERS_TABLE)} (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      app_pubkey          text NOT NULL,
      group_id            uuid NOT NULL,
      group_name          text NOT NULL,
      group_pubkey        text NOT NULL,
      owner_pubkey        text NOT NULL,
      member_pubkey       text NOT NULL,
      encrypted_group_key text NOT NULL,
      role                text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'pending')),
      invited_by          text,
      joined_at           timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      revoked_at          timestamptz
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql(REQUESTS_TABLE)} (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      app_pubkey      text NOT NULL,
      group_id        uuid NOT NULL,
      requester_pubkey text NOT NULL,
      invite_secret   text NOT NULL,
      status          text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      resolved_at     timestamptz
    )
  `;

  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_group_members_active
    ON ${sql(MEMBERS_TABLE)} (app_pubkey, group_id, member_pubkey)
    WHERE revoked_at IS NULL`;

  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_groups_identity
    ON ${sql(GROUPS_TABLE)} (app_pubkey, group_id)`;

  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_group_requests_pending
    ON ${sql(REQUESTS_TABLE)} (app_pubkey, group_id, requester_pubkey)
    WHERE status = 'pending'`;

  service = new GroupsService();
});

beforeEach(async () => {
  const sql = getDb();
  await sql`DELETE FROM ${sql(REQUESTS_TABLE)} WHERE app_pubkey = ${APP}`;
  await sql`DELETE FROM ${sql(MEMBERS_TABLE)} WHERE app_pubkey = ${APP}`;
  await sql`DELETE FROM ${sql(GROUPS_TABLE)} WHERE app_pubkey = ${APP}`;
});

afterAll(async () => {
  await closeDb();
});

describe('GroupsService', () => {
  test('owner can create a group and list it', async () => {
    const created = await service.createGroup(APP, auth(OWNER_PK), {
      group_name: 'Core Team',
      group_pubkey: 'group_pubkey_1',
      encrypted_group_key: 'enc_owner_key_1',
    });

    const mine = await service.listMyGroups(APP, auth(OWNER_PK));
    expect(mine).toHaveLength(1);
    expect(mine[0].group_id).toBe(created.group_id);
    expect(mine[0].my_role).toBe('owner');
    expect(mine[0].group_pubkey).toBe('group_pubkey_1');
  });

  test('owner can add member and member sees delegated group', async () => {
    const created = await service.createGroup(APP, auth(OWNER_PK), {
      group_name: 'Builders',
      group_pubkey: 'group_pubkey_2',
      encrypted_group_key: 'enc_owner_key_2',
    });

    const added = await service.addMember(APP, auth(OWNER_PK), created.group_id, {
      member_npub: npub(MEMBER_PK),
      encrypted_group_key: 'enc_member_key_2',
    });

    expect(added.created).toBe(true);
    expect(added.member.member_pubkey).toBe(MEMBER_PK);
    expect(added.member.role).toBe('member');

    const memberGroups = await service.listMyGroups(APP, auth(MEMBER_PK));
    expect(memberGroups).toHaveLength(1);
    expect(memberGroups[0].group_id).toBe(created.group_id);
  });

  test('non-admin member cannot add another member', async () => {
    const created = await service.createGroup(APP, auth(OWNER_PK), {
      group_name: 'Ops',
      group_pubkey: 'group_pubkey_3',
      encrypted_group_key: 'enc_owner_key_3',
    });

    await service.addMember(APP, auth(OWNER_PK), created.group_id, {
      member_npub: npub(MEMBER_PK),
      encrypted_group_key: 'enc_member_key_3',
    });

    await expect(
      service.addMember(APP, auth(MEMBER_PK), created.group_id, {
        member_npub: npub(OTHER_PK),
        encrypted_group_key: 'enc_other_key_3',
      })
    ).rejects.toThrow('Admin role required');
  });

  test('non-member cannot view member list', async () => {
    const created = await service.createGroup(APP, auth(OWNER_PK), {
      group_name: 'Security',
      group_pubkey: 'group_pubkey_4',
      encrypted_group_key: 'enc_owner_key_4',
    });

    await expect(
      service.listGroupMembers(APP, auth(OTHER_PK), created.group_id)
    ).rejects.toThrow('Group membership required');
  });

  test('join request can be approved and requester gains group membership', async () => {
    const created = await service.createGroup(APP, auth(OWNER_PK), {
      group_name: 'Requests',
      group_pubkey: 'group_pubkey_5',
      encrypted_group_key: 'enc_owner_key_5',
    });

    await service.addMember(APP, auth(OWNER_PK), created.group_id, {
      member_npub: npub(ADMIN_PK),
      encrypted_group_key: 'enc_admin_key_5',
      role: 'admin',
    });

    const req = await service.createJoinRequest(APP, auth(MEMBER_PK), created.group_id, {
      invite_secret: 'invite-123',
    });
    expect(req.created).toBe(true);
    expect(req.request.status).toBe('pending');

    const pending = await service.listJoinRequests(APP, auth(ADMIN_PK), created.group_id, 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].requester_pubkey).toBe(MEMBER_PK);

    const resolved = await service.resolveJoinRequest(APP, auth(OWNER_PK), created.group_id, req.request.id, {
      status: 'approved',
      member_encrypted_group_key: 'enc_member_key_5',
    });
    expect(resolved.request.status).toBe('approved');
    expect(resolved.member?.member_pubkey).toBe(MEMBER_PK);

    const memberGroups = await service.listMyGroups(APP, auth(MEMBER_PK));
    expect(memberGroups).toHaveLength(1);
    expect(memberGroups[0].group_id).toBe(created.group_id);
  });

  test('owner can remove member and member no longer sees group', async () => {
    const created = await service.createGroup(APP, auth(OWNER_PK), {
      group_name: 'Rotate',
      group_pubkey: 'group_pubkey_6',
      encrypted_group_key: 'enc_owner_key_6',
    });

    await service.addMember(APP, auth(OWNER_PK), created.group_id, {
      member_npub: npub(MEMBER_PK),
      encrypted_group_key: 'enc_member_key_6',
    });

    const removed = await service.removeMember(APP, auth(OWNER_PK), created.group_id, npub(MEMBER_PK));
    expect(removed).toBe(true);

    const memberGroups = await service.listMyGroups(APP, auth(MEMBER_PK));
    expect(memberGroups).toHaveLength(0);
  });
});
