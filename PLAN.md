# Flux Adaptor - SuperBased Access Point for Fluxbase

## Overview

Flux Adaptor is a Nostr-native gateway that provides access to a Fluxbase backend via:
1. **Direct HTTP** - Fast path for when you have network access
2. **Nostr/CVM** - Private path via Nostr relays (works behind NAT, no domain needed)

Both paths use **NIP-98** authentication - users sign requests with their Nostr keys.

## Architecture

```
                    ┌─────────────────┐
                    │   App Client    │
                    └────────┬────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
              ▼                             ▼
    ┌─────────────────┐           ┌─────────────────┐
    │  Direct HTTPS   │           │  Nostr Relays   │
    │  (fast path)    │           │  (private path) │
    └────────┬────────┘           └────────┬────────┘
             │                              │
             └──────────────┬───────────────┘
                            ▼
              ┌─────────────────────────┐
              │     FLUX ADAPTOR        │
              │  ┌───────────────────┐  │
              │  │  NIP-98 Verifier  │  │
              │  └─────────┬─────────┘  │
              │            ▼            │
              │  ┌───────────────────┐  │
              │  │  User Mapper      │  │
              │  │  (npub → JWT)     │  │
              │  └─────────┬─────────┘  │
              │            ▼            │
              │  ┌───────────────────┐  │
              │  │  Fluxbase Client  │  │
              │  └─────────┬─────────┘  │
              └────────────┼────────────┘
                           │
                           ▼
              ┌─────────────────────────┐
              │       FLUXBASE          │
              │  (localhost:8090)       │
              │  • Database             │
              │  • Storage              │
              │  • Functions            │
              │  • Realtime             │
              └─────────────────────────┘
```

## Directory Structure

```
flux_adaptor/
├── src/
│   ├── index.ts              # Entry point - starts HTTP + CVM
│   ├── config.ts             # Configuration
│   │
│   ├── transports/
│   │   ├── http.ts           # Hono HTTP server
│   │   └── cvm.ts            # CVM/Nostr transport
│   │
│   ├── auth/
│   │   ├── nip98.ts          # NIP-98 verification
│   │   └── user-mapping.ts   # npub → Fluxbase user/JWT
│   │
│   ├── fluxbase/
│   │   ├── client.ts         # Fluxbase SDK wrapper
│   │   ├── database.ts       # REST API operations
│   │   ├── storage.ts        # Storage operations
│   │   └── functions.ts      # Edge function calls
│   │
│   ├── mcp/
│   │   ├── server.ts         # MCP server setup
│   │   └── tools/
│   │       ├── database.ts   # query, insert, update, delete
│   │       ├── storage.ts    # upload, download, list
│   │       ├── functions.ts  # invoke
│   │       └── auth.ts       # whoami, permissions
│   │
│   └── types.ts              # Shared types
│
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## Implementation Phases

### Phase 1: Core Infrastructure
- [ ] Project setup (package.json, tsconfig, dependencies)
- [ ] Configuration loader (env vars)
- [ ] NIP-98 verification utility
- [ ] Fluxbase client wrapper

### Phase 2: User Mapping
- [ ] npub → Fluxbase user creation/lookup
- [ ] JWT generation for Fluxbase requests
- [ ] Session caching (avoid re-auth every request)

### Phase 3: HTTP Transport
- [ ] Hono server setup
- [ ] NIP-98 middleware
- [ ] REST endpoints that proxy to Fluxbase
- [ ] Error handling and responses

### Phase 4: MCP Tools
- [ ] Database tools (query, insert, update, delete)
- [ ] Storage tools (upload, download, list, delete)
- [ ] Function tools (invoke edge functions)
- [ ] Auth tools (whoami, check permissions)

### Phase 5: CVM Transport
- [ ] Nostr relay connection
- [ ] CVM protocol handler
- [ ] MCP server over CVM
- [ ] Reconnection logic

### Phase 6: Advanced Features
- [ ] Realtime subscriptions bridge
- [ ] Rate limiting
- [ ] Usage tracking / billing hooks
- [ ] Multi-workspace support

## Key Dependencies

```json
{
  "dependencies": {
    "@fluxbase/sdk": "latest",
    "@contextvm/sdk": "latest",
    "hono": "^4.0.0",
    "nostr-tools": "^2.0.0",
    "@noble/hashes": "^1.3.0",
    "@noble/secp256k1": "^2.0.0"
  }
}
```

## Configuration

```env
# Fluxbase connection
FLUXBASE_URL=http://localhost:8090
FLUXBASE_SERVICE_KEY=your-service-role-key

# HTTP server
HTTP_PORT=3080
HTTP_HOST=0.0.0.0

# Nostr/CVM
NOSTR_RELAYS=wss://relay.damus.io,wss://nos.lol
SERVER_PRIVATE_KEY=hex-private-key  # For signing responses

# Optional
ADMIN_NPUBS=npub1xxx,npub1yyy  # Admin users
LOG_LEVEL=info
```

## API Design

### HTTP Endpoints (NIP-98 authenticated)

```
# Database
POST   /db/:table              # Insert
GET    /db/:table              # Query (with filters in query string)
PATCH  /db/:table              # Update (filters in query string)
DELETE /db/:table              # Delete (filters in query string)

# Storage
POST   /storage/:bucket        # Upload file
GET    /storage/:bucket/:path  # Download file
GET    /storage/:bucket        # List files
DELETE /storage/:bucket/:path  # Delete file

# Functions
POST   /functions/:name        # Invoke edge function

# Auth
GET    /auth/me                # Current user info
```

### MCP Tools

```typescript
// Database
db_query({ table, select?, filter?, order?, limit? })
db_insert({ table, data })
db_update({ table, filter, data })
db_delete({ table, filter })

// Storage
storage_upload({ bucket, path, content, contentType })
storage_download({ bucket, path })
storage_list({ bucket, prefix? })
storage_delete({ bucket, path })

// Functions
function_invoke({ name, payload? })

// Auth
auth_whoami()
auth_check_permission({ resource, action })
```

## NIP-98 Flow

1. Client creates HTTP request
2. Client signs request details as Nostr event (kind 27235)
3. Client includes base64 event in `Authorization: Nostr <event>` header
4. Server verifies:
   - Event signature is valid
   - Event is recent (< 60 seconds)
   - URL tag matches request URL
   - Method tag matches request method
5. Server extracts `pubkey` from event
6. Server maps pubkey to Fluxbase user
7. Server generates Fluxbase JWT for that user
8. Server forwards request to Fluxbase with JWT

## User Mapping Strategy

On first request from a new npub:
1. Check if Fluxbase user exists with `nostr_pubkey` metadata
2. If not, create user via Fluxbase Admin API:
   - Email: `{npub}@nostr.local` (placeholder)
   - Password: random (user won't use it)
   - Metadata: `{ nostr_pubkey: hex_pubkey }`
3. Cache the user_id ↔ npub mapping

For subsequent requests:
1. Lookup cached mapping
2. Generate short-lived JWT for that user_id
3. Use JWT for Fluxbase API calls

## Security Considerations

- NIP-98 events must be recent (prevent replay)
- Fluxbase service key never exposed to clients
- JWTs are short-lived (5 min)
- Rate limiting per npub
- Admin npubs can access all resources
- Regular users scoped to their own data via Fluxbase RLS

## Future: Home Sync

For backing up cloud → home:
1. Home instance runs same Flux Adaptor + Fluxbase
2. Sync service periodically pulls from cloud Fluxbase
3. Both instances accessible via same npub (Nostr relays)
4. Client can specify preferred endpoint or auto-failover
