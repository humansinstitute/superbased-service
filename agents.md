# SuperBased Service - Agent Notes

## Test Suite

### Location
- `src/__tests__/records-service.test.ts` - Records service integration tests (54 tests)
- `src/__tests__/prune-records.test.ts` - Prune logic integration tests (7 tests)

### Requirements
- Running Postgres instance
- Default: `postgres://postgres:postgres@localhost:5432/fluxbase`
- Override: set `POSTGRES_URL` env var

### Running
```bash
bun test src/__tests__/               # All tests
bun test src/__tests__/records-service.test.ts  # Records only
bun test src/__tests__/prune-records.test.ts    # Prune only
```

### Test Design

Tests run against real Postgres (not mocked). Each test file:
- `beforeAll`: creates table + indexes with `IF NOT EXISTS`
- `beforeEach`: truncates the table for isolation
- `afterAll`: closes the DB connection

The records-service tests mock `delegationsService.getDelegation` via `spyOn` to control delegation behavior without needing the full delegations table.

### Coverage Map

| Area | Tests | File |
|------|-------|------|
| Record creation (first sync, versions, collections) | 8 | records-service |
| Record updates (CTE atomicity, state transitions) | 6 | records-service |
| Record deletion (soft delete, terminal state) | 5 | records-service |
| Owner fetch (filters, field mapping) | 8 | records-service |
| Delegated fetch (GIN lookup, privacy, owner filter) | 9 | records-service |
| History (version chain, include_data toggle) | 7 | records-service |
| Permissions (owner-only, delegation checks) | 8 | records-service |
| App isolation + full lifecycle | 3 | records-service |
| Prune threshold and behavior | 7 | prune-records |

### Key Spec Assertions Tested

- Atomic CTE: supersede + insert happens in one query (no partial states)
- Deleted records reject further syncs with reason `"record_deleted"`
- Delegated fetch never leaks `encrypted_data` or other delegates' payloads
- `encrypted_from` is preserved through all operations
- Prune keeps live/deleted row + 20 most recent superseded = 21 max
- Prune is idempotent (running twice yields same result)

## v3 Migration (completed)

Migrated records from v2 (mutable CRUD via FluxbaseClient/PostgREST) to v3 (append-only versioned records via direct Postgres). See `CLAUDE.md` for architecture details and `../sb_encrypted_records_spec.md` for the full spec.

### Files changed
- `src/config.ts` - Added `postgresUrl`
- `src/db/postgres.ts` - New Postgres singleton
- `src/types.ts` - v3 record types
- `src/services/records.ts` - Full rewrite with CTE logic
- `src/transports/http.ts` - Updated record routes + history endpoint
- `src/transports/cvm.ts` - Updated MCP tools + history tool
- `src/cli/init-db.ts` - Direct Postgres DDL
- `src/cli/prune-records.ts` - New prune script
