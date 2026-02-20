#!/usr/bin/env bun
/**
 * Prune superseded record versions beyond the 20 most recent.
 * Keeps: live/deleted row + 20 most recent superseded rows = 21 max per record.
 *
 * Usage: bun run src/cli/prune-records.ts
 * Schedule via cron or pm2 for periodic cleanup.
 */

import { getDb, closeDb } from '../db/postgres';

const TABLE = 'superbased_records_v3';

async function main() {
  console.log('SuperBased Records Pruner');
  console.log('='.repeat(40));

  const sql = getDb();

  // Find records with more than 21 total versions
  const candidates = await sql`
    SELECT app_pubkey, record_id, COUNT(*) as total
    FROM ${sql(TABLE)}
    GROUP BY app_pubkey, record_id
    HAVING COUNT(*) > 21
  `;

  if (candidates.length === 0) {
    console.log('No records need pruning.');
    await closeDb();
    return;
  }

  console.log(`Found ${candidates.length} record(s) to prune.\n`);

  let totalPruned = 0;

  for (const { app_pubkey, record_id, total } of candidates) {
    // Delete superseded versions beyond the 20 most recent
    // Never touch live or deleted rows
    const result = await sql`
      DELETE FROM ${sql(TABLE)}
      WHERE id IN (
        SELECT id FROM ${sql(TABLE)}
        WHERE app_pubkey = ${app_pubkey}
          AND record_id = ${record_id}
          AND record_state = 'superseded'
        ORDER BY version DESC
        OFFSET 20
      )
    `;

    const pruned = result.count;
    if (pruned > 0) {
      console.log(`  ${record_id}: pruned ${pruned} of ${total} versions`);
      totalPruned += pruned;
    }
  }

  console.log(`\nDone. Pruned ${totalPruned} superseded version(s).`);
  await closeDb();
}

main().catch(async (err) => {
  console.error('Prune error:', err);
  await closeDb();
  process.exit(1);
});
