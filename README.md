# Flux Adaptor

**Nostr-native gateway to Fluxbase** - Access your backend via HTTP or Nostr relays using cryptographic identity.

## Overview

Flux Adaptor provides two access paths to a Fluxbase backend:

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
│              FLUX ADAPTOR                                   │
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

All endpoints (except `/health`) require NIP-98 authentication.

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
// Connect to Flux Adaptor via CVM
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
Run Fluxbase + Flux Adaptor at home, access via Nostr:
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
