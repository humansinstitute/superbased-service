#!/usr/bin/env bun
/**
 * Initialize the SuperBased database tables
 *
 * Usage: bun run init
 *
 * This creates the superbased_apps table using the Fluxbase DDL API.
 */

import { getConfig } from '../config';
import { FluxbaseClient } from '../fluxbase/client';

async function main() {
  console.log('═'.repeat(60));
  console.log('  SuperBased Database Initialization');
  console.log('═'.repeat(60));

  const config = getConfig();

  if (!config.fluxbaseServiceKey) {
    console.error('\n✗ FLUXBASE_SERVICE_KEY is not set in environment');
    console.error('  This key is required to create database tables.');
    process.exit(1);
  }

  console.log(`\nFluxbase URL: ${config.fluxbaseUrl}`);

  const client = new FluxbaseClient(config.fluxbaseServiceKey);

  // Check connection
  console.log('\nChecking Fluxbase connection...');
  const health = await client.health();
  if (!health.healthy) {
    console.error('✗ Cannot connect to Fluxbase');
    process.exit(1);
  }
  console.log('✓ Connected to Fluxbase');

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.fluxbaseServiceKey}`,
    'apikey': config.fluxbaseServiceKey,
  };

  // Create superbased_apps table using DDL API
  console.log('\nCreating superbased_apps table...');

  const tableRequest = {
    schema: 'public',
    name: 'superbased_apps',
    columns: [
      { name: 'id', type: 'uuid', nullable: false, primaryKey: true, defaultValue: 'gen_random_uuid()' },
      { name: 'app_pubkey', type: 'text', nullable: false, primaryKey: false },
      { name: 'owner_pubkey', type: 'text', nullable: false, primaryKey: false },
      { name: 'name', type: 'text', nullable: false, primaryKey: false },
      { name: 'schema_name', type: 'text', nullable: false, primaryKey: false },
      { name: 'attestation_event', type: 'text', nullable: false, primaryKey: false },
      { name: 'created_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
      { name: 'updated_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
    ],
  };

  try {
    const res = await fetch(`${config.fluxbaseUrl}/api/v1/ddl/tables`, {
      method: 'POST',
      headers,
      body: JSON.stringify(tableRequest),
    });

    const result = await res.json();

    if (res.ok) {
      console.log('✓ superbased_apps table created');
    } else if (res.status === 409 || result.error?.includes('already exists')) {
      console.log('✓ superbased_apps table already exists');
    } else {
      console.error(`✗ Failed to create table: ${result.error || res.statusText}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`✗ Failed to create table: ${err}`);
    process.exit(1);
  }

  // Create superbased_records table
  console.log('\nCreating superbased_records table...');

  const recordsTableRequest = {
    schema: 'public',
    name: 'superbased_records',
    columns: [
      { name: 'id', type: 'uuid', nullable: false, primaryKey: true, defaultValue: 'gen_random_uuid()' },
      { name: 'app_pubkey', type: 'text', nullable: false, primaryKey: false },
      { name: 'user_pubkey', type: 'text', nullable: false, primaryKey: false },
      { name: 'record_id', type: 'text', nullable: false, primaryKey: false },
      { name: 'collection', type: 'text', nullable: false, primaryKey: false, defaultValue: "'default'" },
      { name: 'encrypted_data', type: 'text', nullable: false, primaryKey: false },
      { name: 'metadata', type: 'jsonb', nullable: false, primaryKey: false, defaultValue: "'{}'" },
      { name: 'created_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
      { name: 'updated_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
    ],
  };

  try {
    const res = await fetch(`${config.fluxbaseUrl}/api/v1/ddl/tables`, {
      method: 'POST',
      headers,
      body: JSON.stringify(recordsTableRequest),
    });

    const result = await res.json();

    if (res.ok) {
      console.log('✓ superbased_records table created');
    } else if (res.status === 409 || result.error?.includes('already exists')) {
      console.log('✓ superbased_records table already exists');
    } else {
      console.error(`✗ Failed to create records table: ${result.error || res.statusText}`);
      console.log('  You may need to create it manually via psql');
    }
  } catch (err) {
    console.error(`✗ Failed to create records table: ${err}`);
    console.log('  You may need to create it manually via psql');
  }

  console.log('\n' + '═'.repeat(60));
  console.log('  Database initialization complete!');
  console.log('═'.repeat(60));
  console.log('\nYou can now run: bun run cli');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
