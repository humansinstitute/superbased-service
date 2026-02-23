#!/usr/bin/env bun

import { closeDb } from '../db/postgres';
import { storageService } from '../services/storage';

async function main() {
  const limit = process.argv[2] ? Number(process.argv[2]) : 500;

  if (!Number.isFinite(limit) || limit <= 0) {
    console.error('Invalid limit. Usage: bun run src/cli/prune-storage.ts [limit]');
    process.exit(1);
  }

  const pruned = await storageService.pruneExpired(Math.floor(limit));
  console.log(`Pruned ${pruned} expired/deleted storage object(s).`);

  await closeDb();
}

main().catch(async (err) => {
  console.error('Storage prune failed:', err);
  await closeDb();
  process.exit(1);
});
