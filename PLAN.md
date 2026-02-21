# SuperBased Service - SuperBased Access Point for Fluxbase

## Overview

SuperBased Service is a Nostr-native gateway that provides access to a Fluxbase backend via:
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
              │     SUPERBASED SERVICE        │
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
1. Home instance runs same SuperBased Service + Fluxbase
2. Sync service periodically pulls from cloud Fluxbase
3. Both instances accessible via same npub (Nostr relays)
4. Client can specify preferred endpoint or auto-failover

---

## Delegation System

### Overview

The delegation system allows users to share encrypted records with other Nostr users (delegates). Each record can have multiple delegates, and each delegate receives their own encrypted copy of the data.

### Record Structure

```typescript
// Record with delegate encryption
{
  record_id: "todo_abc123",
  collection: "todos",
  encrypted_data: "...",  // Owner's NIP-44 encrypted copy
  metadata: {
    owner: "npub1owner...",
    assigned_to: "npub1delegate...",  // Per-record assignment
    updated_at: "2024-01-15T10:30:00Z",
  },
  delegates: [
    {
      delegate_pubkey: "npub1delegate1...",  // or hex pubkey
      encrypted_blob: "..."  // NIP-44 encrypted for this delegate
    },
    {
      delegate_pubkey: "npub1delegate2...",
      encrypted_blob: "..."  // Different encryption for delegate2
    }
  ]
}
```

### Permission Levels

| Level | Read | Write |
|-------|------|-------|
| App "read" delegation | All owner's records | No |
| App "write" delegation | No | All owner's records |
| Per-record (metadata.assigned_to) | Assigned record only | Assigned record only |

### Encryption Flow

1. **Owner creates record**: Encrypted with owner's key → `encrypted_data`
2. **Owner assigns delegate**:
   - Decrypt the payload
   - Re-encrypt with delegate's pubkey
   - Add to `delegates` array
3. **Delegate fetches**: Uses `?delegate=true` endpoint, decrypts their `encrypted_blob`

---

## Remote Agent Spec

A remote agent (e.g., an AI assistant, automation bot) can find and process tasks assigned to it.

### Authentication

The agent needs a Nostr keypair:

```javascript
// Agent setup
const agentSecret = hexToBytes("agent_private_key_hex");
const agentPubkey = getPublicKey(agentSecret);
const agentNpub = nip19.npubEncode(agentPubkey);
```

### Discovery Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     REMOTE AGENT WORKFLOW                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. AUTHENTICATE                                                 │
│     ┌────────────────┐                                          │
│     │ Agent Keypair  │                                          │
│     │ (nsec/npub)    │                                          │
│     └───────┬────────┘                                          │
│             │ Sign NIP-98 request                                │
│             ▼                                                    │
│  2. FETCH DELEGATED RECORDS                                     │
│     ┌────────────────────────────────────────┐                  │
│     │ GET /records/:app/fetch?delegate=true  │                  │
│     │ Authorization: Nostr <signed_event>    │                  │
│     └───────┬────────────────────────────────┘                  │
│             │                                                    │
│             ▼                                                    │
│  3. FIND YOUR ENCRYPTED BLOB                                    │
│     ┌────────────────────────────────────────┐                  │
│     │ For each record:                       │                  │
│     │   delegates.find(d =>                  │                  │
│     │     d.delegate_pubkey === agentPubkey  │                  │
│     │   )                                    │                  │
│     └───────┬────────────────────────────────┘                  │
│             │                                                    │
│             ▼                                                    │
│  4. DECRYPT & PROCESS                                           │
│     ┌────────────────────────────────────────┐                  │
│     │ nip44.decrypt(                         │                  │
│     │   agentSecret,                         │                  │
│     │   ownerPubkey,                         │                  │
│     │   delegate.encrypted_blob              │                  │
│     │ )                                      │                  │
│     └───────┬────────────────────────────────┘                  │
│             │                                                    │
│             ▼                                                    │
│  5. UPDATE & SYNC BACK                                          │
│     ┌────────────────────────────────────────┐                  │
│     │ POST /records/:app/sync                │                  │
│     │ (Agent has write permission via        │                  │
│     │  metadata.assigned_to match)           │                  │
│     └────────────────────────────────────────┘                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Agent Implementation

```typescript
// agent.ts - Example remote agent
import { nip44, nip19, finalizeEvent, verifyEvent } from 'nostr-tools';

interface DelegateEncryption {
  delegate_pubkey: string;
  encrypted_blob: string;
}

interface DelegatedRecord {
  record_id: string;
  collection: string;
  encrypted_data: string;  // Owner's copy (agent can't decrypt)
  delegates?: DelegateEncryption[];
  metadata: {
    assigned_to?: string;
    owner?: string;
  };
  owner_pubkey: string;
  updated_at: string;
}

class TaskAgent {
  private secret: Uint8Array;
  private pubkey: string;
  private npub: string;
  private baseUrl: string;
  private appNpub: string;

  constructor(secretHex: string, baseUrl: string, appNpub: string) {
    this.secret = hexToBytes(secretHex);
    this.pubkey = getPublicKey(this.secret);
    this.npub = nip19.npubEncode(this.pubkey);
    this.baseUrl = baseUrl;
    this.appNpub = appNpub;
  }

  // Create NIP-98 auth header
  async createAuth(url: string, method: string): Promise<string> {
    const event = finalizeEvent({
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['u', url],
        ['method', method],
      ],
      content: '',
    }, this.secret);
    return `Nostr ${btoa(JSON.stringify(event))}`;
  }

  // Fetch tasks assigned to this agent
  async fetchAssignedTasks(): Promise<any[]> {
    const url = `${this.baseUrl}/records/${this.appNpub}/fetch?delegate=true`;
    const auth = await this.createAuth(url, 'GET');

    const response = await fetch(url, {
      headers: { 'Authorization': auth }
    });

    const { records } = await response.json();

    // Decrypt records assigned to us
    const tasks = [];
    for (const record of records) {
      const myDelegate = record.delegates?.find(
        (d: DelegateEncryption) =>
          d.delegate_pubkey === this.pubkey ||
          d.delegate_pubkey === this.npub
      );

      if (myDelegate) {
        // Decrypt using NIP-44
        const conversationKey = nip44.v2.utils.getConversationKey(
          this.secret,
          record.owner_pubkey
        );
        const plaintext = nip44.v2.decrypt(
          myDelegate.encrypted_blob,
          conversationKey
        );
        const task = JSON.parse(plaintext);
        tasks.push({
          ...task,
          _record_id: record.record_id,
          _owner_pubkey: record.owner_pubkey,
        });
      }
    }

    return tasks;
  }

  // Update a task (agent has write permission via assigned_to)
  async updateTask(recordId: string, ownerPubkey: string, updates: any): Promise<void> {
    // Re-encrypt updated data for owner
    const ownerKey = nip44.v2.utils.getConversationKey(this.secret, ownerPubkey);
    const encryptedForOwner = nip44.v2.encrypt(
      JSON.stringify(updates),
      ownerKey
    );

    // Also create delegate copy for ourselves
    const selfKey = nip44.v2.utils.getConversationKey(this.secret, this.pubkey);
    const encryptedForSelf = nip44.v2.encrypt(
      JSON.stringify(updates),
      selfKey
    );

    const url = `${this.baseUrl}/records/${this.appNpub}/sync`;
    const body = {
      records: [{
        record_id: recordId,
        encrypted_data: encryptedForOwner,
        metadata: { assigned_to: this.npub },
        delegates: [{
          delegate_pubkey: this.npub,
          encrypted_blob: encryptedForSelf,
        }],
      }]
    };

    const auth = await this.createAuth(url, 'POST');
    await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }
}

// Example usage
const agent = new TaskAgent(
  process.env.AGENT_SECRET!,
  'https://flux.example.com',
  'npub1appxxx...'
);

// Poll for tasks
setInterval(async () => {
  const tasks = await agent.fetchAssignedTasks();

  for (const task of tasks) {
    if (task.state === 'new' && !task.done) {
      console.log(`Processing task: ${task.title}`);

      // Do the work...

      // Mark as done
      await agent.updateTask(task._record_id, task._owner_pubkey, {
        ...task,
        state: 'done',
        done: 1,
        updated_at: new Date().toISOString(),
      });
    }
  }
}, 30000);  // Check every 30 seconds
```

### Security Notes

1. **Agent keypair**: Store securely (env var, secret manager)
2. **Encryption**: Agent can only decrypt records explicitly encrypted to it
3. **Write permissions**: Agent can only modify records where `metadata.assigned_to` matches its pubkey
4. **Audit trail**: All changes are signed with agent's key, traceable via NIP-98
