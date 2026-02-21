# SuperBased Service

Nostr-authenticated encrypted records service with dual transports:
- HTTP (`src/transports/http.ts`)
- MCP over Nostr/CVM (`src/transports/cvm.ts`)

## Architecture (v3)

The records layer is now direct Postgres with append-only versioned rows.

- Storage table: `superbased_records_v3`
- Record states: `live` -> `superseded` -> `deleted` (terminal)
- Writes are atomic CTE transitions (supersede + insert in one query)
- Delegated reads use GIN-indexed `delegate_payloads` JSONB lookups
- `encrypted_from` is preserved across versions for decryption key derivation

Reference docs:
- `CLAUDE.md` (service architecture + patterns)
- `../sb_encrypted_records_spec.md` (record protocol/spec)

## Quick Start

```bash
bun install
cp .env.example .env
bun run init
bun run dev
```

Useful scripts:

```bash
bun run dev        # Hot reload
bun run start      # Production start
bun run init       # Create/upgrade DB tables + indexes
bun run prune      # Prune superseded versions
bun run typecheck  # TypeScript check
bun run test       # Integration tests (requires Postgres)
```

## Docker

```bash
cp .env.example .env
docker compose up -d --build
curl http://localhost:3080/health
```

Notes:
- If `POSTGRES_URL` is unset, compose uses bundled Postgres: `postgres://postgres:postgres@postgres:5432/fluxbase`
- Data persists in `postgres_data` volume
- Schema init runs via `src/cli/init-db.ts`

## Configuration

| Variable | Description | Default |
|---|---|---|
| `HTTP_PORT` | HTTP port | `3080` |
| `HTTP_HOST` | HTTP host bind | `0.0.0.0` |
| `NOSTR_RELAYS` | Comma-separated relay URLs | `wss://relay.damus.io,wss://nos.lol` |
| `SERVER_PRIVATE_KEY` | Server private key hex (auto-generated if empty) | - |
| `ADMIN_NPUBS` | Comma-separated admin npubs | - |
| `NIP98_MAX_AGE_SECONDS` | Max accepted NIP-98 auth event age | `60` |
| `SERVICE_TOKEN` | Optional Bearer token for service-level access | - |
| `POSTGRES_URL` | Postgres connection URL | `postgres://postgres:postgres@localhost:5432/fluxbase` |
| `LOG_LEVEL` | Log level | `info` |
| `PUSH_ENABLED` | Enable Web Push features | `false` |
| `PUSH_VAPID_PUBLIC_KEY` | Web Push VAPID public key | - |
| `PUSH_VAPID_PRIVATE_KEY` | Web Push VAPID private key | - |
| `PUSH_VAPID_SUBJECT` | Web Push subject | - |

## Authentication

Protected endpoints/tools use NIP-98 auth:

```txt
Authorization: Nostr <base64-encoded-kind-27235-event>
```

Supported alternative for service integrations:

```txt
Authorization: Bearer <SERVICE_TOKEN>
```

## HTTP API

Public endpoints:
- `GET /health`
- `GET /ui`
- `POST /connect/token`

Core endpoints:
- Auth: `GET /auth/me`
- Apps: `POST /apps/register`, `GET /apps`, `GET /apps/:appNpub`, `POST /apps/:appNpub/token`
- Delegations: `POST /delegations`, `GET /delegations`, `DELETE /delegations/:delegateNpub`
- App delegations: `POST /apps/:appNpub/delegate`, `GET /apps/:appNpub/delegations`, `DELETE /apps/:appNpub/delegate/:delegateNpub`
- Push (default namespace + app namespace): `/push/*`, `/apps/:appNpub/push/*`
- Records (default namespace): `POST /records/sync`, `GET /records/fetch`, `GET /records/delegated`, `GET /records/history/:recordId`, `DELETE /records?record_id=...`
- Records (per-app namespace): `POST /records/:appNpub/sync`, `GET /records/:appNpub/fetch`, `GET /records/:appNpub/delegated`, `GET /records/:appNpub/history/:recordId`, `DELETE /records/:appNpub?record_id=...`

Deprecated/stubbed endpoints (intentional `501`):
- `/db/:table`
- `/storage/:bucket/*`
- `/functions/:name`

## MCP Tools (CVM)

Implemented:
- `health`
- `auth_whoami`
- `register_app`
- `list_apps`
- `get_app`
- `generate_token`
- `generate_connection_token`
- `sync_records`
- `fetch_records`
- `fetch_delegated_records`
- `delete_record`
- `get_record_history`

Stubbed (not implemented):
- `db_query`, `db_insert`, `db_update`, `db_delete`
- `storage_upload`, `storage_download`, `storage_list`, `storage_delete`
- `function_invoke`

## Testing

Integration tests run against real Postgres.

Default DB:
- `postgres://postgres:postgres@localhost:5432/fluxbase`

Override with:
- `POSTGRES_URL`

Run:

```bash
bun test src/__tests__/
bun test src/__tests__/records-service.test.ts
bun test src/__tests__/prune-records.test.ts
```

Coverage focus:
- append-only sync/versioning
- deletion terminal behavior
- delegated privacy constraints
- history behavior
- prune threshold and idempotency
- [ ] Home ↔ Cloud sync

## License

MIT
