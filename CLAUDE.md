# SuperBased Service - Project Instructions

## Architecture

Nostr-native gateway to Fluxbase with two transports: HTTP (`src/transports/http.ts`) and CVM/MCP (`src/transports/cvm.ts`). Auth via NIP-98.

### Records Layer (v3)

Records use **direct Postgres** (`src/db/postgres.ts`) with append-only versioned rows. NOT FluxbaseClient.

- Table: `superbased_records_v3`
- States: `live` → `superseded` → `deleted` (terminal)
- Updates use atomic CTEs: supersede old row + insert new version in one query
- Delegate lookups use GIN-indexed JSONB (`delegate_payloads ? $pubkey`)
- Spec: `../sb_encrypted_records_spec.md`

Everything else (apps, delegations, users, storage, db proxy) still uses FluxbaseClient.

## Key Commands

```bash
bun run dev        # Dev server with hot reload
bun run start      # Production
bun run init       # Initialize database tables + indexes
bun run typecheck  # TypeScript check
bun run test       # Run test suite (requires Postgres)
bun run prune      # Prune old superseded record versions
```

## Testing

Integration tests require a running Postgres instance.

```bash
# Default connection (override with POSTGRES_URL env var):
# postgres://postgres:postgres@localhost:5432/fluxbase

bun test src/__tests__/                    # All tests
bun test src/__tests__/records-service.test.ts  # Records service (54 tests)
bun test src/__tests__/prune-records.test.ts    # Prune logic (7 tests)
```

Tests create their own tables with `IF NOT EXISTS` and truncate between runs. Safe to run against a dev database.

### What the tests cover

- **Record creation**: first sync, version numbering, collection assignment, encrypted_from preservation
- **Record updates**: atomic versioning via CTE, state transitions, delegate_payloads on updates
- **Record deletion**: soft delete (inserts deleted version), no further syncs after delete
- **Fetch (owner)**: collection filter, since filter, only live records, correct field mapping
- **Fetch (delegated)**: GIN-indexed lookup, privacy (only requesting delegate's payload returned, encrypted_data stripped), owner filter
- **History**: full version chain, include_data toggle, ordering
- **Permissions**: owner-only writes, app-level delegation checks
- **Prune**: threshold (<=21 untouched), keeps 20 most recent superseded + live/deleted, idempotent

## Important Patterns

- `getDb()` returns a singleton `postgres.Sql` instance - do not create new connections
- `closeDb()` must be called in CLI scripts for clean exit
- Record permission: owner check first, then `delegationsService.getDelegation()` for app-level delegation
- Delegated fetch strips `encrypted_data` and returns only the requesting delegate's payload as `delegate_payload` (singular)
- The `encrypted_from` field is critical for NIP-44 decryption key derivation - always preserve it
