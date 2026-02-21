# SuperBased Service

**Nostr-native gateway to Fluxbase** - Access your backend via HTTP or Nostr relays using cryptographic identity.

## Overview

SuperBased Service provides two access paths to a Fluxbase backend:

1. **Direct HTTP** - Fast path when you have network access
2. **Nostr/CVM** - Private path via Nostr relays (works behind NAT, no domain needed)

Both paths use **NIP-98** authentication - users sign requests with their Nostr keys. No passwords, no API keys in apps.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     APP CLIENTS                             │
│                                                             │
│    ┌──────────────────┐         ┌──────────────────┐       │
│    │   Fast Path      │         │   Private Path   │       │
│    │   (HTTPS)        │         │   (Nostr/CVM)    │       │
│    └────────┬─────────┘         └────────┬─────────┘       │
└─────────────┼───────────────────────────┼───────────────────┘
              │                            │
              ▼                            ▼
┌─────────────────────────────────────────────────────────────┐
│              SUPERBASED SERVICE                                   │
│                                                             │
│    ┌──────────────────────────────────────────────┐        │
│    │            NIP-98 Verification               │        │
│    │       (Cryptographic auth via Nostr)         │        │
│    └──────────────────────┬───────────────────────┘        │
│                           ▼                                 │
│    ┌──────────────────────────────────────────────┐        │
│    │       npub → Fluxbase User Mapping           │        │
│    │      (Auto-create users on first request)    │        │
│    └──────────────────────┬───────────────────────┘        │
│                           ▼                                 │
│    ┌──────────────────────────────────────────────┐        │
│    │           Fluxbase API Client                │        │
│    └──────────────────────┬───────────────────────┘        │
└───────────────────────────┼─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                       FLUXBASE                              │
│           (Database, Storage, Functions, Realtime)          │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Install Dependencies

```bash
cd flux_adaptor
bun install
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your Fluxbase URL and keys
```

### 3. Run

```bash
bun run dev   # Development with hot reload
bun start     # Production
```

## Docker Deploy (New Server)

This repo now includes a full Docker setup for:
- `superbased-service` (the SuperBased service)
- `postgres` (persistent database)

### 1. Prepare env

```bash
cp .env.example .env
```

Set at minimum:
- `SERVER_PRIVATE_KEY` (64-char hex, keep this stable per deployment)
- Any relay/admin settings you want

Postgres behavior:
- If `POSTGRES_URL` is not set, compose defaults to bundled Postgres container (`postgres://postgres:postgres@postgres:5432/fluxbase`).
- If you already have a Postgres instance with existing data, set `POSTGRES_URL` explicitly (for example `postgres://postgres:postgres@host.docker.internal:5432/fluxbase`).

### 2. Start stack

```bash
docker compose up -d --build
```

### 3. Verify

```bash
docker compose ps
curl http://localhost:3080/health
```

### 4. Logs and updates

```bash
docker compose logs -f superbased-service
docker compose pull
docker compose up -d --build
```

Notes:
- Postgres data is persisted in docker volume `postgres_data`.
- Postgres is internal to Docker network by default (not exposed on host port `5432`).
- DB schema is initialized automatically at service startup (`src/cli/init-db.ts`).
- `pgcrypto` extension is created on first Postgres init (`docker/postgres-init/01-extensions.sql`).
- If your old data is in another Postgres container/host, point `POSTGRES_URL` there before starting the stack.

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `FLUXBASE_URL` | Fluxbase server URL | `http://localhost:8090` |
| `FLUXBASE_SERVICE_KEY` | Service role key for admin operations | - |
| `HTTP_PORT` | HTTP server port | `3080` |
| `NOSTR_RELAYS` | Comma-separated relay URLs | `wss://relay.damus.io` |
| `SERVER_PRIVATE_KEY` | Server identity (hex, auto-generated if empty) | - |
| `ADMIN_NPUBS` | Comma-separated admin npubs | - |

## HTTP API

Protected endpoints require NIP-98 authentication. Public utility endpoints: `/health`, `/ui`, `/connect/token`.

Built-in tools:
- `GET /ui` - Browser UI to generate and decode connection keys
- `POST /connect/token` - Generate an app-agnostic connection key (unsigned base64 JSON metadata)

### Authentication

Include a signed NIP-98 event in the Authorization header:

```
Authorization: Nostr <base64-encoded-event>
```

The event (kind 27235) must include:
- `u` tag: Request URL
- `method` tag: HTTP method
- `payload` tag: SHA256 hash of body (for POST/PUT/PATCH)

### Endpoints

#### Auth
```
GET /auth/me              # Current user info
POST /connect/token       # Generate connection key (metadata only)
```

#### Database
```
GET    /db/:table         # Query records
POST   /db/:table         # Insert records
PATCH  /db/:table         # Update records (filter in query string)
DELETE /db/:table         # Delete records (filter in query string)
```

#### Storage
```
POST   /storage/:bucket/* # Upload file
GET    /storage/:bucket/* # Download file
GET    /storage/:bucket   # List files
DELETE /storage/:bucket/* # Delete file
```

#### Functions
```
POST   /functions/:name   # Invoke edge function
```

## MCP Tools (via Nostr/CVM)

When connecting via Nostr relays, these MCP tools are available:

| Tool | Description |
|------|-------------|
| `health` | Check service health |
| `auth_whoami` | Get current user info |
| `db_query` | Query database records |
| `db_insert` | Insert database records |
| `db_update` | Update database records |
| `db_delete` | Delete database records |
| `storage_upload` | Upload file (base64 content) |
| `storage_download` | Download file |
| `storage_list` | List files in bucket |
| `storage_delete` | Delete file |
| `function_invoke` | Invoke edge function |

## Use Cases

### 1. Standard Web App
Direct HTTPS for best performance:
```typescript
const response = await fetch('https://api.example.com/db/posts', {
  headers: {
    'Authorization': `Nostr ${base64Event}`,
  },
});
```

### 2. Privacy-Focused App
Route through Nostr relays:
```typescript
// Connect to SuperBased Service via CVM
const client = new CvmClient({
  serverNpub: 'npub1...',
  relays: ['wss://relay.damus.io'],
});

const posts = await client.call('db_query', {
  table: 'posts',
  filter: { published: true },
});
```

### 3. Home Server (No Domain)
Run Fluxbase + SuperBased Service at home, access via Nostr:
- No domain name needed
- No port forwarding required
- Works behind any NAT

### 4. Cloud + Local Backup
- Cloud instance for production
- Home instance synced as backup
- Same npub works on both

## Security

- **NIP-98**: Cryptographic request signing (no passwords)
- **User Mapping**: npub → Fluxbase user (auto-created)
- **Short-lived JWTs**: Generated per-request
- **Admin Control**: Configurable admin npubs

## Development

```bash
bun run dev          # Start with hot reload
bun run typecheck    # Type check
```

## Roadmap

- [ ] Full CVM protocol implementation with @contextvm/sdk
- [ ] Realtime subscriptions bridge
- [ ] Rate limiting per npub
- [ ] Usage tracking / billing hooks
- [ ] Multi-workspace support
- [ ] Home ↔ Cloud sync

## License

MIT
