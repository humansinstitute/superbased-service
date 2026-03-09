#!/usr/bin/env bun
/**
 * Initialize the SuperBased database tables using direct Postgres.
 *
 * Usage: bun run src/cli/init-db.ts
 */

import { getDb, closeDb } from '../db/postgres';

async function main() {
  console.log('='.repeat(60));
  console.log('  SuperBased Database Initialization (direct Postgres)');
  console.log('='.repeat(60));

  const sql = getDb();

  // Test connection
  console.log('\nChecking Postgres connection...');
  try {
    const [{ now }] = await sql`SELECT now()`;
    console.log(`  Connected at ${now}`);
  } catch (err) {
    console.error(`  Failed to connect: ${err}`);
    process.exit(1);
  }

  // ── superbased_apps ──
  console.log('\nCreating superbased_apps...');
  await sql`
    CREATE TABLE IF NOT EXISTS superbased_apps (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      app_pubkey      text NOT NULL,
      owner_pubkey    text NOT NULL,
      name            text NOT NULL,
      schema_name     text NOT NULL,
      attestation_event text NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    )
  `;
  console.log('  done');

  // ── superbased_users ──
  console.log('Creating superbased_users...');
  await sql`
    CREATE TABLE IF NOT EXISTS superbased_users (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_pubkey     text NOT NULL,
      balance         integer NOT NULL DEFAULT 5000,
      whitelist       boolean NOT NULL DEFAULT true,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    )
  `;
  console.log('  done');

  // ── superbased_app_delegations ──
  console.log('Creating superbased_app_delegations...');
  await sql`
    CREATE TABLE IF NOT EXISTS superbased_app_delegations (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      app_pubkey      text NOT NULL,
      owner_pubkey    text NOT NULL,
      delegate_pubkey text NOT NULL,
      permissions     text[] NOT NULL DEFAULT ARRAY[]::text[],
      created_at      timestamptz NOT NULL DEFAULT now(),
      revoked_at      timestamptz
    )
  `;
  console.log('  done');

  // ── superbased_groups ──
  console.log('Creating superbased_groups...');
  await sql`
    CREATE TABLE IF NOT EXISTS superbased_groups (
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
  console.log('  done');

  // ── superbased_group_members ──
  console.log('Creating superbased_group_members...');
  await sql`
    CREATE TABLE IF NOT EXISTS superbased_group_members (
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
  console.log('  done');

  // ── superbased_group_requests ──
  console.log('Creating superbased_group_requests...');
  await sql`
    CREATE TABLE IF NOT EXISTS superbased_group_requests (
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
  console.log('  done');

  // ── superbased_records_v3 ──
  console.log('Creating superbased_records_v3...');
  await sql`
    CREATE TABLE IF NOT EXISTS superbased_records_v3 (
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
      group_payloads jsonb,
      created_at      timestamptz NOT NULL DEFAULT now()
    )
  `;
  console.log('  done');

  // Ensure new columns exist on older deployments
  await sql`ALTER TABLE superbased_records_v3 ADD COLUMN IF NOT EXISTS group_payloads jsonb`;

  // Normalize older deployments to the canonical uuid contract for record IDs.
  console.log('Normalizing superbased_records_v3.record_id to uuid if needed...');
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'superbased_records_v3'
          AND column_name = 'record_id'
          AND udt_name = 'text'
      ) THEN
        ALTER TABLE superbased_records_v3
          ALTER COLUMN record_id TYPE uuid
          USING record_id::uuid;
      END IF;
    END
    $$;
  `;
  console.log('  done');

  // ── superbased_record_group_access ──
  console.log('Creating superbased_record_group_access...');
  await sql`
    CREATE TABLE IF NOT EXISTS superbased_record_group_access (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      app_pubkey      text NOT NULL,
      collection      text NOT NULL,
      record_id       uuid NOT NULL,
      group_id        uuid NOT NULL,
      can_read        boolean NOT NULL DEFAULT true,
      can_write       boolean NOT NULL DEFAULT false,
      created_by      text NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      revoked_at      timestamptz
    )
  `;
  console.log('  done');

  console.log('Normalizing superbased_record_group_access.record_id to uuid if needed...');
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'superbased_record_group_access'
          AND column_name = 'record_id'
          AND udt_name = 'text'
      ) THEN
        ALTER TABLE superbased_record_group_access
          ALTER COLUMN record_id TYPE uuid
          USING record_id::uuid;
      END IF;
    END
    $$;
  `;
  console.log('  done');

  // ── superbased_push_subscriptions ──
  console.log('Creating superbased_push_subscriptions...');
  await sql`
    CREATE TABLE IF NOT EXISTS superbased_push_subscriptions (
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
  console.log('  done');

  // ── superbased_retained_usage_hourly ──
  console.log('Creating superbased_retained_usage_hourly...');
  await sql`
    CREATE TABLE IF NOT EXISTS superbased_retained_usage_hourly (
      captured_hour          timestamptz NOT NULL,
      user_pubkey            text NOT NULL,
      live_records           integer NOT NULL,
      retained_rows          integer NOT NULL,
      retained_bytes         bigint NOT NULL,
      encrypted_data_bytes   bigint NOT NULL,
      delegate_payload_bytes bigint NOT NULL,
      created_at             timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (captured_hour, user_pubkey)
    )
  `;
  console.log('  done');

  // ── superbased_storage_objects ──
  console.log('Creating superbased_storage_objects...');
  await sql`
    CREATE TABLE IF NOT EXISTS superbased_storage_objects (
      id              uuid PRIMARY KEY,
      app_pubkey      text NOT NULL,
      owner_pubkey    text NOT NULL,
      bucket          text NOT NULL,
      object_key      text NOT NULL,
      file_name       text NOT NULL,
      mime_type       text NOT NULL,
      size_bytes      bigint NOT NULL CHECK (size_bytes > 0),
      status          text NOT NULL CHECK (status IN ('pending', 'ready', 'deleted')),
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      completed_at    timestamptz,
      expires_at      timestamptz,
      deleted_at      timestamptz
    )
  `;
  console.log('  done');

  // ── Indexes ──
  console.log('\nCreating indexes...');

  console.log('  uq_records_v3_version...');
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_records_v3_version
      ON superbased_records_v3 (app_pubkey, record_id, version)
  `;

  console.log('  uq_records_v3_live...');
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_records_v3_live
      ON superbased_records_v3 (app_pubkey, record_id)
      WHERE record_state = 'live'
  `;

  console.log('  idx_records_v3_owner...');
  await sql`
    CREATE INDEX IF NOT EXISTS idx_records_v3_owner
      ON superbased_records_v3 (app_pubkey, user_pubkey, record_state)
  `;

  console.log('  idx_records_v3_changes_check...');
  await sql`
    CREATE INDEX IF NOT EXISTS idx_records_v3_changes_check
      ON superbased_records_v3 (app_pubkey, user_pubkey, collection, created_at DESC)
      WHERE record_state = 'live'
  `;

  console.log('  idx_records_v3_delegates (GIN)...');
  await sql`
    CREATE INDEX IF NOT EXISTS idx_records_v3_delegates
      ON superbased_records_v3 USING GIN (delegate_payloads)
  `;

  console.log('  idx_records_v3_groups (GIN)...');
  await sql`
    CREATE INDEX IF NOT EXISTS idx_records_v3_groups
      ON superbased_records_v3 USING GIN (group_payloads)
  `;

  console.log('  uq_groups_identity...');
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_groups_identity
      ON superbased_groups (app_pubkey, group_id)
  `;

  // Backfill canonical groups from existing membership seeds (legacy schema)
  console.log('  backfill_groups_from_members...');
  await sql`
    INSERT INTO superbased_groups (app_pubkey, group_id, group_name, group_pubkey, owner_pubkey)
    SELECT DISTINCT ON (m.app_pubkey, m.group_id)
      m.app_pubkey,
      m.group_id,
      m.group_name,
      m.group_pubkey,
      m.owner_pubkey
    FROM superbased_group_members m
    WHERE m.revoked_at IS NULL
    ORDER BY
      m.app_pubkey,
      m.group_id,
      CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END,
      m.created_at ASC
    ON CONFLICT (app_pubkey, group_id)
    DO UPDATE SET
      group_name = EXCLUDED.group_name,
      group_pubkey = EXCLUDED.group_pubkey,
      owner_pubkey = EXCLUDED.owner_pubkey,
      archived_at = NULL,
      updated_at = now()
  `;

  console.log('  idx_groups_owner_lookup...');
  await sql`
    CREATE INDEX IF NOT EXISTS idx_groups_owner_lookup
      ON superbased_groups (app_pubkey, owner_pubkey, archived_at)
  `;

  console.log('  idx_groups_pubkey_lookup...');
  await sql`
    CREATE INDEX IF NOT EXISTS idx_groups_pubkey_lookup
      ON superbased_groups (app_pubkey, group_pubkey, archived_at)
  `;

  console.log('  uq_group_members_active...');
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_group_members_active
      ON superbased_group_members (app_pubkey, group_id, member_pubkey)
      WHERE revoked_at IS NULL
  `;

  console.log('  idx_group_members_member_lookup...');
  await sql`
    CREATE INDEX IF NOT EXISTS idx_group_members_member_lookup
      ON superbased_group_members (app_pubkey, member_pubkey, revoked_at)
  `;

  console.log('  idx_group_members_group_lookup...');
  await sql`
    CREATE INDEX IF NOT EXISTS idx_group_members_group_lookup
      ON superbased_group_members (app_pubkey, group_id, revoked_at)
  `;

  console.log('  idx_group_members_delegate_lookup...');
  await sql`
    CREATE INDEX IF NOT EXISTS idx_group_members_delegate_lookup
      ON superbased_group_members (app_pubkey, group_pubkey, revoked_at)
  `;

  console.log('  uq_group_requests_pending...');
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_group_requests_pending
      ON superbased_group_requests (app_pubkey, group_id, requester_pubkey)
      WHERE status = 'pending'
  `;

  console.log('  idx_group_requests_group_status...');
  await sql`
    CREATE INDEX IF NOT EXISTS idx_group_requests_group_status
      ON superbased_group_requests (app_pubkey, group_id, status, created_at DESC)
  `;

  console.log('  idx_group_requests_requester_status...');
  await sql`
    CREATE INDEX IF NOT EXISTS idx_group_requests_requester_status
      ON superbased_group_requests (app_pubkey, requester_pubkey, status, created_at DESC)
  `;

  console.log('  uq_record_group_access_active...');
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_record_group_access_active
      ON superbased_record_group_access (app_pubkey, collection, record_id, group_id)
      WHERE revoked_at IS NULL
  `;

  console.log('  idx_record_group_access_record...');
  await sql`
    CREATE INDEX IF NOT EXISTS idx_record_group_access_record
      ON superbased_record_group_access (app_pubkey, collection, record_id, revoked_at)
  `;

  console.log('  idx_record_group_access_group...');
  await sql`
    CREATE INDEX IF NOT EXISTS idx_record_group_access_group
      ON superbased_record_group_access (app_pubkey, group_id, revoked_at)
  `;

  console.log('  uq_push_subscription_endpoint...');
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_push_subscription_endpoint
      ON superbased_push_subscriptions (app_pubkey, owner_pubkey, endpoint)
  `;

  console.log('  idx_push_owner_app...');
  await sql`
    CREATE INDEX IF NOT EXISTS idx_push_owner_app
      ON superbased_push_subscriptions (app_pubkey, owner_pubkey)
  `;

  console.log('  idx_retained_usage_latest...');
  await sql`
    CREATE INDEX IF NOT EXISTS idx_retained_usage_latest
      ON superbased_retained_usage_hourly (captured_hour DESC, retained_bytes DESC)
  `;

  console.log('  uq_storage_object_key...');
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_storage_object_key
      ON superbased_storage_objects (bucket, object_key)
  `;

  console.log('  idx_storage_owner_app...');
  await sql`
    CREATE INDEX IF NOT EXISTS idx_storage_owner_app
      ON superbased_storage_objects (app_pubkey, owner_pubkey, status, created_at DESC)
  `;

  console.log('  idx_storage_expires...');
  await sql`
    CREATE INDEX IF NOT EXISTS idx_storage_expires
      ON superbased_storage_objects (expires_at)
      WHERE expires_at IS NOT NULL
  `;

  console.log('  done');

  console.log('\n' + '='.repeat(60));
  console.log('  Database initialization complete!');
  console.log('='.repeat(60));

  await closeDb();
}

main().catch(async (err) => {
  console.error('Unexpected error:', err);
  await closeDb();
  process.exit(1);
});
