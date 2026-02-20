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
      created_at      timestamptz NOT NULL DEFAULT now()
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

  console.log('  idx_records_v3_delegates (GIN)...');
  await sql`
    CREATE INDEX IF NOT EXISTS idx_records_v3_delegates
      ON superbased_records_v3 USING GIN (delegate_payloads)
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
