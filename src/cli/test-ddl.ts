#!/usr/bin/env bun
/**
 * Test direct Postgres connection for v3 atomic record operations.
 * Verifies: table creation, indexes, CTE atomic versioning.
 */

import postgres from 'postgres';

const sql = postgres({
  host: 'localhost',
  port: 5432,
  database: 'fluxbase',
  username: 'postgres',
  password: 'postgres',
});

async function main() {
  console.log('Testing direct Postgres connection for v3 operations\n');

  // Test 1: Basic connection
  console.log('--- Test 1: Connection ---');
  try {
    const [row] = await sql`SELECT 1 as ok`;
    console.log(`OK: ${JSON.stringify(row)}\n`);
  } catch (e) {
    console.error(`FAILED: ${e}\n`);
    process.exit(1);
  }

  // Test 2: Create v3 test table
  console.log('--- Test 2: Create table ---');
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS _test_records_v3 (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_pubkey      text NOT NULL,
        record_id       uuid NOT NULL,
        user_pubkey     text NOT NULL,
        version         integer NOT NULL,
        record_state    text NOT NULL,
        collection      text NOT NULL DEFAULT 'default',
        encrypted_data  text NOT NULL,
        encrypted_from  text NOT NULL,
        delegate_payloads jsonb,
        created_at      timestamptz NOT NULL DEFAULT now()
      )
    `;
    console.log('OK: table created\n');
  } catch (e) {
    console.error(`FAILED: ${e}\n`);
  }

  // Test 3: Create all v3 indexes
  console.log('--- Test 3: Create indexes ---');
  try {
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_test_v3_version
      ON _test_records_v3 (app_pubkey, record_id, version)
    `;
    console.log('OK: version uniqueness index');

    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_test_v3_live
      ON _test_records_v3 (app_pubkey, record_id)
      WHERE record_state = 'live'
    `;
    console.log('OK: partial unique "one live row" index');

    await sql`
      CREATE INDEX IF NOT EXISTS idx_test_v3_owner
      ON _test_records_v3 (app_pubkey, user_pubkey, record_state)
    `;
    console.log('OK: owner lookup index');

    await sql`
      CREATE INDEX IF NOT EXISTS idx_test_v3_delegates
      ON _test_records_v3 USING GIN (delegate_payloads)
    `;
    console.log('OK: GIN index on delegate_payloads\n');
  } catch (e) {
    console.error(`FAILED: ${e}\n`);
  }

  const APP = 'deadbeef';
  const USER = 'cafebabe';
  const RECORD = '00000000-0000-0000-0000-000000000001';

  // Test 4: INSERT version 1 (create)
  console.log('--- Test 4: Insert version 1 ---');
  try {
    const [row] = await sql`
      INSERT INTO _test_records_v3 (app_pubkey, record_id, user_pubkey, version, record_state, encrypted_data, encrypted_from)
      VALUES (${APP}, ${RECORD}, ${USER}, 1, 'live', 'ciphertext_v1', ${USER})
      RETURNING record_id, version, record_state
    `;
    console.log(`OK: ${JSON.stringify(row)}\n`);
  } catch (e) {
    console.error(`FAILED: ${e}\n`);
  }

  // Test 5: Atomic CTE — supersede v1 + insert v2
  console.log('--- Test 5: CTE atomic supersede + insert ---');
  try {
    const [row] = await sql`
      WITH superseded AS (
        UPDATE _test_records_v3
        SET record_state = 'superseded'
        WHERE app_pubkey = ${APP}
          AND record_id = ${RECORD}
          AND record_state = 'live'
        RETURNING version, user_pubkey
      )
      INSERT INTO _test_records_v3 (app_pubkey, record_id, user_pubkey, version, record_state, encrypted_data, encrypted_from)
      SELECT
        ${APP},
        ${RECORD},
        (SELECT user_pubkey FROM superseded),
        (SELECT version FROM superseded) + 1,
        'live',
        'ciphertext_v2',
        ${USER}
      RETURNING record_id, version, record_state
    `;
    console.log(`OK: ${JSON.stringify(row)}\n`);
  } catch (e) {
    console.error(`FAILED: ${e}\n`);
  }

  // Test 6: Verify both rows exist with correct states
  console.log('--- Test 6: Verify version chain ---');
  try {
    const rows = await sql`
      SELECT record_id, version, record_state, encrypted_data
      FROM _test_records_v3
      WHERE app_pubkey = ${APP} AND record_id = ${RECORD}
      ORDER BY version
    `;
    for (const row of rows) {
      console.log(`  v${row.version}: state=${row.record_state}, data=${row.encrypted_data}`);
    }
    console.log(`OK: ${rows.length} versions\n`);
  } catch (e) {
    console.error(`FAILED: ${e}\n`);
  }

  // Test 7: Verify partial unique index blocks second "live" row
  console.log('--- Test 7: Partial unique index enforcement ---');
  try {
    await sql`
      INSERT INTO _test_records_v3 (app_pubkey, record_id, user_pubkey, version, record_state, encrypted_data, encrypted_from)
      VALUES (${APP}, ${RECORD}, ${USER}, 99, 'live', 'should_fail', ${USER})
    `;
    console.log('UNEXPECTED: insert succeeded (index not enforced!)\n');
  } catch (e: any) {
    if (e.message?.includes('uq_test_v3_live')) {
      console.log(`OK: correctly rejected duplicate live row\n`);
    } else {
      console.log(`OK (rejected): ${e.message}\n`);
    }
  }

  // Test 8: CTE delete (supersede + insert deleted version)
  console.log('--- Test 8: CTE atomic delete ---');
  try {
    const [row] = await sql`
      WITH superseded AS (
        UPDATE _test_records_v3
        SET record_state = 'superseded'
        WHERE app_pubkey = ${APP}
          AND record_id = ${RECORD}
          AND record_state = 'live'
        RETURNING version, user_pubkey
      )
      INSERT INTO _test_records_v3 (app_pubkey, record_id, user_pubkey, version, record_state, encrypted_data, encrypted_from)
      SELECT
        ${APP},
        ${RECORD},
        (SELECT user_pubkey FROM superseded),
        (SELECT version FROM superseded) + 1,
        'deleted',
        '',
        ${USER}
      RETURNING record_id, version, record_state
    `;
    console.log(`OK: ${JSON.stringify(row)}\n`);
  } catch (e) {
    console.error(`FAILED: ${e}\n`);
  }

  // Test 9: GIN index query for delegate lookup
  console.log('--- Test 9: GIN delegate_payloads query ---');
  try {
    // Insert a record with delegate_payloads
    await sql`
      INSERT INTO _test_records_v3 (app_pubkey, record_id, user_pubkey, version, record_state, encrypted_data, encrypted_from, delegate_payloads)
      VALUES (${APP}, '00000000-0000-0000-0000-000000000002', ${USER}, 1, 'live', 'owner_cipher', ${USER},
        ${sql.json({ 'delegate_abc': 'delegate_cipher_abc', 'delegate_xyz': 'delegate_cipher_xyz' })})
    `;

    const rows = await sql`
      SELECT record_id, delegate_payloads
      FROM _test_records_v3
      WHERE app_pubkey = ${APP}
        AND record_state = 'live'
        AND delegate_payloads ? 'delegate_abc'
    `;
    console.log(`OK: found ${rows.length} record(s) for delegate_abc`);
    if (rows[0]) {
      console.log(`  payloads keys: ${Object.keys(rows[0].delegate_payloads).join(', ')}\n`);
    }
  } catch (e) {
    console.error(`FAILED: ${e}\n`);
  }

  // Test 10: Final state dump
  console.log('--- Test 10: Full table dump ---');
  try {
    const rows = await sql`
      SELECT record_id, version, record_state, encrypted_data
      FROM _test_records_v3
      ORDER BY record_id, version
    `;
    for (const row of rows) {
      console.log(`  ${row.record_id} v${row.version}: ${row.record_state} | ${row.encrypted_data || '(empty)'}`);
    }
    console.log();
  } catch (e) {
    console.error(`FAILED: ${e}\n`);
  }

  // Cleanup
  console.log('--- Cleanup ---');
  try {
    await sql`DROP TABLE IF EXISTS _test_records_v3`;
    console.log('OK: test table dropped\n');
  } catch (e) {
    console.error(`Cleanup failed: ${e}\n`);
  }

  await sql.end();
  console.log('All tests complete.');
}

main().catch(console.error);
