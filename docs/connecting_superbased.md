# Connecting to SuperBased

SuperBased provides two methods to connect to the Fluxbase backend:

1. **HTTPS (Direct)** - Fast, low-latency connection when you have network access
2. **Nostr/CVM** - Private connection via Nostr relays (works behind NAT, no domain needed)

Both methods use **NIP-98** authentication - you sign requests with your Nostr private key. No passwords or API keys required in your application.

**Base URL:** `https://superbased.otherstuff.ai`

---

## Authentication: NIP-98

All requests (except health checks) require NIP-98 authentication. This is a Nostr event (kind 27235) that proves you control a specific keypair.

### How NIP-98 Works

1. Your app creates a Nostr event describing the request
2. The event is signed with your private key
3. The signed event is sent in the `Authorization` header
4. The server verifies the signature and extracts your public key
5. Your pubkey becomes your identity - no registration needed

### NIP-98 Event Structure

```json
{
  "kind": 27235,
  "created_at": 1706000000,
  "tags": [
    ["u", "https://superbased.otherstuff.ai/db/posts"],
    ["method", "GET"],
    ["payload", "<sha256-hash-of-body>"]
  ],
  "content": "",
  "pubkey": "<your-hex-pubkey>",
  "id": "<event-id>",
  "sig": "<signature>"
}
```

| Tag | Required | Description |
|-----|----------|-------------|
| `u` | Yes | Full request URL |
| `method` | Yes | HTTP method (GET, POST, PATCH, DELETE) |
| `payload` | For POST/PATCH | SHA256 hash of request body |

### Authorization Header

```
Authorization: Nostr <base64-encoded-event>
```

---

## Option 1: HTTPS (Direct Connection)

Use this when you have direct network access to SuperBased. Lowest latency option.

### Endpoints

### Connection Bootstrap

You can use the built-in web UI for setup:

```
GET https://superbased.otherstuff.ai/ui
```

The UI can generate and decode connection keys, and request a connection key from:

```
POST https://superbased.otherstuff.ai/connect/token
```

Notes:
- `/connect/token` returns unsigned base64 JSON metadata (not a credential).
- API requests still require NIP-98 signatures per request.

#### Health Check (No Auth)
```
GET https://superbased.otherstuff.ai/health
```

#### Authentication
```
GET https://superbased.otherstuff.ai/auth/me
```
Returns your user info based on NIP-98 authentication.

#### Database Operations
```
GET    https://superbased.otherstuff.ai/db/:table     # Query records
POST   https://superbased.otherstuff.ai/db/:table     # Insert records
PATCH  https://superbased.otherstuff.ai/db/:table     # Update records
DELETE https://superbased.otherstuff.ai/db/:table     # Delete records
```

**Query Parameters:**
- `select` - Columns to return (comma-separated)
- `limit` - Maximum records
- `offset` - Skip N records
- `order` - Sort column (e.g., `created_at.desc`)
- `<column>=eq.<value>` - Filter by column value

#### Storage Operations
```
POST   https://superbased.otherstuff.ai/storage/:bucket/*   # Upload file
GET    https://superbased.otherstuff.ai/storage/:bucket/*   # Download file
GET    https://superbased.otherstuff.ai/storage/:bucket     # List files
DELETE https://superbased.otherstuff.ai/storage/:bucket/*   # Delete file
```

#### Edge Functions
```
POST   https://superbased.otherstuff.ai/functions/:name     # Invoke function
```

### JavaScript Example (HTTPS)

```javascript
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

// Your Nostr private key (keep secret!)
const privateKey = /* your private key bytes */;

/**
 * Create NIP-98 Authorization header
 */
async function createNip98Auth(url, method, body) {
  const tags = [
    ['u', url],
    ['method', method.toUpperCase()],
  ];

  // Add payload hash for POST/PATCH
  if (body && ['POST', 'PATCH', 'PUT'].includes(method.toUpperCase())) {
    const bodyHash = bytesToHex(sha256(new TextEncoder().encode(body)));
    tags.push(['payload', bodyHash]);
  }

  const event = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  }, privateKey);

  return `Nostr ${btoa(JSON.stringify(event))}`;
}

/**
 * Make authenticated request to SuperBased
 */
async function superbasedFetch(path, options = {}) {
  const url = `https://superbased.otherstuff.ai${path}`;
  const method = options.method || 'GET';
  const body = options.body ? JSON.stringify(options.body) : undefined;

  const auth = await createNip98Auth(url, method, body);

  const response = await fetch(url, {
    ...options,
    method,
    body,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': auth,
      ...options.headers,
    },
  });

  return response.json();
}

// Usage Examples
async function examples() {
  // Get current user
  const me = await superbasedFetch('/auth/me');
  console.log('Logged in as:', me.npub);

  // Query posts
  const posts = await superbasedFetch('/db/posts?limit=10&order=created_at.desc');
  console.log('Posts:', posts);

  // Insert a record
  const newPost = await superbasedFetch('/db/posts', {
    method: 'POST',
    body: { title: 'Hello World', content: 'My first post' },
  });
  console.log('Created:', newPost);

  // Update a record
  await superbasedFetch('/db/posts?id=eq.123', {
    method: 'PATCH',
    body: { title: 'Updated Title' },
  });

  // Delete a record
  await superbasedFetch('/db/posts?id=eq.123', {
    method: 'DELETE',
  });
}
```

### Using with Browser Extension (NIP-07)

If the user has a Nostr browser extension (nos2x, Alby, etc.):

```javascript
async function createNip98AuthWithExtension(url, method, body) {
  if (!window.nostr) {
    throw new Error('No Nostr extension found');
  }

  const tags = [
    ['u', url],
    ['method', method.toUpperCase()],
  ];

  if (body) {
    const bodyHash = bytesToHex(sha256(new TextEncoder().encode(body)));
    tags.push(['payload', bodyHash]);
  }

  const event = await window.nostr.signEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  });

  return `Nostr ${btoa(JSON.stringify(event))}`;
}
```

---

## Option 2: Nostr/CVM (Relay Connection)

Use this when you want privacy, are behind NAT, or don't have a domain. Connects via Nostr relays using the ContextVM protocol.

### Server Information

| Property | Value |
|----------|-------|
| Server npub | `npub1...` (get from service provider) |
| Relays | `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.nostr.band` |

### Available MCP Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `health` | Check service health | None |
| `auth_whoami` | Get current user info | None |
| `db_query` | Query database records | `table`, `select?`, `filter?`, `order?`, `limit?`, `offset?` |
| `db_insert` | Insert records | `table`, `data` |
| `db_update` | Update records | `table`, `filter`, `data` |
| `db_delete` | Delete records | `table`, `filter` |
| `storage_upload` | Upload file (base64) | `bucket`, `path`, `content`, `contentType?` |
| `storage_download` | Download file | `bucket`, `path` |
| `storage_list` | List files | `bucket`, `prefix?`, `limit?`, `offset?` |
| `storage_delete` | Delete file | `bucket`, `path` |
| `function_invoke` | Call edge function | `name`, `payload?` |

### JavaScript Example (CVM/Nostr)

```javascript
import { Client } from '@modelcontextprotocol/sdk/client';
import {
  NostrClientTransport,
  PrivateKeySigner,
  ApplesauceRelayPool,
} from '@contextvm/sdk';

// Configuration
const SERVER_PUBKEY = '<server-hex-pubkey>'; // Get from service provider
const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

/**
 * Create SuperBased CVM client
 */
async function createClient(privateKeyHex) {
  const client = new Client({
    name: 'my-app',
    version: '1.0.0',
  });

  const transport = new NostrClientTransport({
    serverPubkey: SERVER_PUBKEY,
    signer: new PrivateKeySigner(privateKeyHex),
    relayHandler: new ApplesauceRelayPool(RELAYS),
    isStateless: true,
  });

  await client.connect(transport);
  return client;
}

/**
 * Call an MCP tool and parse response
 */
async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });

  const textContent = result.content?.find(c => c.type === 'text');
  if (textContent?.text) {
    return JSON.parse(textContent.text);
  }
  return result;
}

// Usage Examples
async function examples() {
  const privateKey = '<your-hex-private-key>';
  const client = await createClient(privateKey);

  // Health check
  const health = await callTool(client, 'health');
  console.log('Health:', health);

  // Get current user
  const me = await callTool(client, 'auth_whoami');
  console.log('Logged in as:', me.npub);

  // Query posts
  const posts = await callTool(client, 'db_query', {
    table: 'posts',
    limit: 10,
    order: { column: 'created_at', ascending: false },
  });
  console.log('Posts:', posts);

  // Insert a record
  const newPost = await callTool(client, 'db_insert', {
    table: 'posts',
    data: { title: 'Hello World', content: 'My first post' },
  });
  console.log('Created:', newPost);

  // Update a record
  await callTool(client, 'db_update', {
    table: 'posts',
    filter: { id: 123 },
    data: { title: 'Updated Title' },
  });

  // Delete a record
  await callTool(client, 'db_delete', {
    table: 'posts',
    filter: { id: 123 },
  });

  // Upload a file
  const fileContent = btoa('Hello, World!'); // Base64 encode
  await callTool(client, 'storage_upload', {
    bucket: 'uploads',
    path: 'hello.txt',
    content: fileContent,
    contentType: 'text/plain',
  });

  // Download a file
  const file = await callTool(client, 'storage_download', {
    bucket: 'uploads',
    path: 'hello.txt',
  });
  const decoded = atob(file.content);
  console.log('File content:', decoded);

  // Invoke an edge function
  const result = await callTool(client, 'function_invoke', {
    name: 'my-function',
    payload: { foo: 'bar' },
  });
  console.log('Function result:', result);
}
```

---

## Choosing Between HTTPS and CVM

| Factor | HTTPS | CVM/Nostr |
|--------|-------|-----------|
| **Latency** | Lower | Higher (relay hop) |
| **Privacy** | Server sees your IP | Server only sees relay |
| **NAT/Firewall** | Requires direct access | Works anywhere |
| **Domain Required** | Yes (for server) | No |
| **Offline Support** | No | Can queue via relays |
| **Setup Complexity** | Simple | Slightly more complex |

### Recommended Approach

1. **Try HTTPS first** - Use for speed when you have network access
2. **Fall back to CVM** - Use when HTTPS fails or for privacy-sensitive operations
3. **Home servers** - Use CVM exclusively (no domain/port forwarding needed)

```javascript
async function smartFetch(path, options) {
  try {
    // Try direct HTTPS first
    return await superbasedFetch(path, options);
  } catch (error) {
    // Fall back to CVM
    console.log('HTTPS failed, falling back to CVM');
    return await cvmRequest(path, options);
  }
}
```

---

## User Identity

Your identity is your Nostr public key (npub). The same keypair works across:
- Multiple apps
- Both connection methods (HTTPS and CVM)
- Multiple SuperBased instances

**First Request:** When you first connect with a new npub, SuperBased automatically creates a user account for you. No registration required.

**Data Ownership:** Your data is associated with your npub. Use Row Level Security (RLS) policies in Fluxbase to ensure users can only access their own data.

---

## Error Handling

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 400 | Bad request (invalid parameters) |
| 401 | Authentication failed (invalid/expired NIP-98) |
| 403 | Forbidden (insufficient permissions) |
| 404 | Not found |
| 500 | Server error |

### NIP-98 Errors

| Error | Cause | Solution |
|-------|-------|----------|
| "Missing Authorization header" | No auth header | Include NIP-98 header |
| "Invalid event signature" | Bad signature | Check private key |
| "Event too old" | Timestamp > 60s ago | Generate fresh event |
| "URL mismatch" | URL in event doesn't match | Use exact request URL |
| "Method mismatch" | Method in event doesn't match | Use correct HTTP method |

---

## Security Best Practices

1. **Never expose private keys** - Keep them in secure storage (keychain, encrypted file)
2. **Use NIP-07 in browsers** - Let extensions handle key management
3. **Fresh timestamps** - Generate NIP-98 events immediately before requests
4. **Validate responses** - Check for errors before using data
5. **Use HTTPS in production** - CVM provides privacy but not encryption beyond relay
6. **Implement RLS** - Configure Fluxbase Row Level Security for data isolation

---

## Dependencies

### For HTTPS Connection
```json
{
  "nostr-tools": "^2.10.0",
  "@noble/hashes": "^1.7.0"
}
```

### For CVM Connection
```json
{
  "@contextvm/sdk": "^0.2.5",
  "@modelcontextprotocol/sdk": "^1.11.0",
  "nostr-tools": "^2.10.0"
}
```

---

## Support

- GitHub: [github.com/superbased](https://github.com/superbased)
- Nostr: Follow `npub1...` for updates
