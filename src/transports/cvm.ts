/**
 * CVM (Context VM) Transport - MCP over Nostr relays
 *
 * This allows clients to connect via Nostr websocket relays
 * instead of direct HTTP, providing:
 * - Privacy (no direct IP connection)
 * - NAT traversal (works behind firewalls)
 * - Decentralization (relay redundancy)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  NostrServerTransport,
  PrivateKeySigner,
  ApplesauceRelayPool,
} from '@contextvm/sdk';
import { z } from 'zod';
import { bytesToHex } from '@noble/hashes/utils';
import { nip19 } from 'nostr-tools';

import { getConfig } from '../config';
import { createAuthContext } from '../auth/nip98';
import { getDb } from '../db/postgres';
import { appsService } from '../services/apps';
import { recordsService } from '../services/records';
import type { AuthContext, SyncRecordInputV3 } from '../types';

// MCP Server instance
let mcpServer: McpServer | null = null;
let transport: NostrServerTransport | null = null;

/**
 * Extract caller pubkey from MCP extra context
 */
function getCallerPubkeyHex(extra: unknown): string | null {
  const authInfo = (extra as { authInfo?: { pubkey?: string } } | undefined)?.authInfo;
  if (!authInfo?.pubkey) return null;

  // Handle both npub and hex formats
  const pubkey = authInfo.pubkey;
  if (pubkey.startsWith('npub1')) {
    const decoded = nip19.decode(pubkey);
    if (decoded.type === 'npub') {
      return decoded.data;
    }
  }
  return pubkey;
}

/**
 * Get auth context from MCP extra, throws if not authenticated
 */
async function getAuthFromExtra(extra: unknown): Promise<AuthContext> {
  const pubkeyHex = getCallerPubkeyHex(extra);
  if (!pubkeyHex) {
    throw new Error('Authentication required - no client pubkey found');
  }

  return createAuthContext(pubkeyHex);
}

/**
 * Helper to create JSON content response for MCP
 */
// NIP-44 plaintext limit is 65535 bytes; MCP protocol framing adds overhead.
// Keep payload under this to avoid encryption failures.
const CVM_MAX_PAYLOAD_BYTES = 60000;

function jsonContent(data: unknown) {
  const text = JSON.stringify(data);
  return {
    content: [{ type: 'text' as const, text }],
  };
}

/**
 * Build a paginated records response that fits within NIP-44 limits.
 * Progressively drops records from the end until the payload fits.
 */
function paginatedJsonContent(
  records: any[],
  hasMore: boolean,
  cursorField: string = 'created_at'
) {
  let slice = records;
  let adjustedHasMore = hasMore;

  while (slice.length > 0) {
    const result: any = { records: slice };
    result.has_more = adjustedHasMore || slice.length < records.length;
    if (result.has_more && slice.length > 0) {
      result.cursor = slice[slice.length - 1][cursorField];
    }

    const text = JSON.stringify(result);
    const byteLen = new TextEncoder().encode(text).length;

    if (byteLen <= CVM_MAX_PAYLOAD_BYTES) {
      return { content: [{ type: 'text' as const, text }] };
    }

    // Too large — drop the last record and mark has_more
    slice = slice.slice(0, -1);
    adjustedHasMore = true;
  }

  // Empty result
  const text = JSON.stringify({ records: [], has_more: hasMore });
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * Register all MCP tools
 */
function registerTools(server: McpServer) {
  // Health check (no auth required)
  server.tool(
    'health',
    'Check service health and database connection',
    {},
    async () => {
      let dbHealthy = false;
      try {
        const sql = getDb();
        await sql`SELECT 1`;
        dbHealthy = true;
      } catch {
        // db unreachable
      }
      return jsonContent({
        status: dbHealthy ? 'ok' : 'degraded',
        adaptor: 'superbased-service',
        postgres: { healthy: dbHealthy },
      });
    }
  );

  // Auth - who am I
  server.tool(
    'auth_whoami',
    'Get current authenticated user info',
    {},
    async (_params, extra) => {
      const auth = await getAuthFromExtra(extra);
      return jsonContent({
        npub: auth.npub,
        pubkey: auth.pubkey,
        isAdmin: auth.isAdmin,
      });
    }
  );

  // Database tools (stubbed)
  server.tool(
    'db_query',
    'Query records from a database table (not implemented)',
    {
      table: z.string().describe('Table name to query'),
    },
    async () => {
      throw new Error('Not implemented — direct DB proxy removed');
    }
  );

  server.tool(
    'db_insert',
    'Insert records into a database table (not implemented)',
    {
      table: z.string().describe('Table name'),
    },
    async () => {
      throw new Error('Not implemented — direct DB proxy removed');
    }
  );

  server.tool(
    'db_update',
    'Update records in a database table (not implemented)',
    {
      table: z.string().describe('Table name'),
    },
    async () => {
      throw new Error('Not implemented — direct DB proxy removed');
    }
  );

  server.tool(
    'db_delete',
    'Delete records from a database table (not implemented)',
    {
      table: z.string().describe('Table name'),
    },
    async () => {
      throw new Error('Not implemented — direct DB proxy removed');
    }
  );

  // Storage tools (stubbed)
  server.tool(
    'storage_upload',
    'Upload a file to storage (not implemented)',
    {
      bucket: z.string().describe('Storage bucket name'),
    },
    async () => {
      throw new Error('Not implemented — storage proxy removed');
    }
  );

  server.tool(
    'storage_download',
    'Download a file from storage (not implemented)',
    {
      bucket: z.string().describe('Storage bucket name'),
    },
    async () => {
      throw new Error('Not implemented — storage proxy removed');
    }
  );

  server.tool(
    'storage_list',
    'List files in a storage bucket (not implemented)',
    {
      bucket: z.string().describe('Storage bucket name'),
    },
    async () => {
      throw new Error('Not implemented — storage proxy removed');
    }
  );

  server.tool(
    'storage_delete',
    'Delete a file from storage (not implemented)',
    {
      bucket: z.string().describe('Storage bucket name'),
    },
    async () => {
      throw new Error('Not implemented — storage proxy removed');
    }
  );

  // Functions (stubbed)
  server.tool(
    'function_invoke',
    'Invoke an edge function (not implemented)',
    {
      name: z.string().describe('Function name to invoke'),
    },
    async () => {
      throw new Error('Not implemented — functions proxy removed');
    }
  );

  // ==================== App Registry Tools ====================

  // Register app
  server.tool(
    'register_app',
    'Register a new app with attestation signed by app owner',
    {
      name: z.string().describe('App name'),
      attestation: z.string().describe('Base64-encoded attestation event signed by app'),
    },
    async (params, extra) => {
      const auth = await getAuthFromExtra(extra);
      const result = await appsService.registerApp(auth, params.name, params.attestation);
      return jsonContent(result);
    }
  );

  // List apps
  server.tool(
    'list_apps',
    'List apps owned by authenticated user',
    {},
    async (_params, extra) => {
      const auth = await getAuthFromExtra(extra);
      const apps = await appsService.listApps(auth.pubkey);
      return jsonContent({ apps });
    }
  );

  // Get app info
  server.tool(
    'get_app',
    'Get app information by npub',
    {
      app_npub: z.string().describe('App npub'),
    },
    async (params, extra) => {
      await getAuthFromExtra(extra); // Require auth
      const appInfo = await appsService.getAppByNpub(params.app_npub);
      if (!appInfo) {
        throw new Error('App not found');
      }
      return jsonContent(appInfo);
    }
  );

  // Generate token
  server.tool(
    'generate_token',
    'Generate access token for an app (must be owner)',
    {
      app_npub: z.string().describe('App npub'),
      relay: z.string().optional().describe('Relay URL for CVM'),
      http: z.string().optional().describe('HTTP endpoint URL'),
    },
    async (params, extra) => {
      const auth = await getAuthFromExtra(extra);
      const token = await appsService.generateToken(auth, params.app_npub, {
        relay: params.relay,
        http: params.http,
      });
      return jsonContent({ token });
    }
  );

  server.tool(
    'generate_connection_token',
    'Generate app-agnostic connection token',
    {
      relay: z.string().optional().describe('Relay URL for CVM'),
      http: z.string().optional().describe('HTTP endpoint URL'),
      ttl_seconds: z.number().optional().describe('Token TTL in seconds'),
      scopes: z.array(z.string()).optional().describe('Advisory scope labels'),
    },
    async (params, extra) => {
      const token = await appsService.generateConnectionToken({
        relay: params.relay,
        http: params.http,
        ttl_seconds: params.ttl_seconds,
        scopes: params.scopes,
      });
      return jsonContent({ token });
    }
  );

  // ==================== Record Sync Tools (v3) ====================

  // Sync records
  server.tool(
    'sync_records',
    'Sync encrypted records to app storage (append-only versioned)',
    {
      app_npub: z.string().describe('App npub to sync to'),
      records: z.array(z.object({
        record_id: z.string(),
        encrypted_data: z.string().describe('NIP-44 ciphertext encrypted to the owner'),
        encrypted_from: z.string().describe('Hex pubkey of whoever encrypted the data'),
        collection: z.string().optional(),
        delegate_payloads: z.record(z.string()).optional().describe('Map of delegate hex pubkey to NIP-44 encrypted blob'),
        owner_pubkey: z.string().optional().describe('Owner hex pubkey — for delegate-on-behalf writes'),
      })).describe('Records to sync'),
    },
    async (params, extra) => {
      const auth = await getAuthFromExtra(extra);

      const decoded = nip19.decode(params.app_npub);
      if (decoded.type !== 'npub') throw new Error('Invalid app_npub');
      const appPubkey = decoded.data as string;

      const result = await recordsService.syncRecords(
        appPubkey,
        auth,
        params.records as SyncRecordInputV3[]
      );
      return jsonContent(result);
    }
  );

  // Fetch records (paginated for CVM — NIP-44 has 64KB plaintext limit)
  server.tool(
    'fetch_records',
    'Fetch own live encrypted records from app storage. Paginated: use cursor from previous response to get next page.',
    {
      app_npub: z.string().describe('App npub to fetch from'),
      collection: z.string().optional().describe('Filter by collection'),
      since: z.string().optional().describe('Only records created after this ISO timestamp'),
      limit: z.number().optional().describe('Max records per page (default 10, max 50)'),
      cursor: z.string().optional().describe('Pagination cursor from previous response'),
    },
    async (params, extra) => {
      const auth = await getAuthFromExtra(extra);

      const decoded = nip19.decode(params.app_npub);
      if (decoded.type !== 'npub') throw new Error('Invalid app_npub');
      const appPubkey = decoded.data as string;

      const limit = Math.min(params.limit || 10, 50);
      const result = await recordsService.fetchRecords(
        appPubkey,
        auth,
        params.collection,
        params.since,
        limit,
        params.cursor
      );
      return paginatedJsonContent(result.records, result.has_more ?? false);
    }
  );

  // Fetch delegated records (paginated for CVM — NIP-44 has 64KB plaintext limit)
  server.tool(
    'fetch_delegated_records',
    'Fetch records delegated to the caller. Returns only the requesting delegate\'s encrypted blob — owner blobs and other delegates\' blobs are stripped. Paginated: use cursor from previous response to get next page.',
    {
      app_npub: z.string().describe('App npub to fetch delegated records from'),
      collection: z.string().optional().describe('Filter by collection name'),
      owner: z.string().optional().describe('Filter by owner hex pubkey'),
      limit: z.number().optional().describe('Max records per page (default 10, max 50)'),
      cursor: z.string().optional().describe('Pagination cursor from previous response'),
    },
    async (params, extra) => {
      const auth = await getAuthFromExtra(extra);

      const decoded = nip19.decode(params.app_npub);
      if (decoded.type !== 'npub') throw new Error('Invalid app_npub');
      const appPubkey = decoded.data as string;

      const limit = Math.min(params.limit || 10, 50);
      const result = await recordsService.fetchDelegatedRecords(
        appPubkey,
        auth.pubkey,
        params.collection,
        params.owner,
        limit,
        params.cursor
      );
      return paginatedJsonContent(result.records, result.has_more ?? false);
    }
  );

  // Delete record (inserts terminal deleted version)
  server.tool(
    'delete_record',
    'Delete a record (inserts a terminal deleted version)',
    {
      app_npub: z.string().describe('App npub'),
      record_id: z.string().describe('Record ID to delete'),
    },
    async (params, extra) => {
      const auth = await getAuthFromExtra(extra);

      const decoded = nip19.decode(params.app_npub);
      if (decoded.type !== 'npub') throw new Error('Invalid app_npub');
      const appPubkey = decoded.data as string;

      const result = await recordsService.deleteRecord(appPubkey, auth, params.record_id);
      if (!result) {
        throw new Error('Record not found or already deleted');
      }
      return jsonContent(result);
    }
  );

  // Record history
  server.tool(
    'get_record_history',
    'Get full version history for a record (all versions, all states)',
    {
      app_npub: z.string().describe('App npub'),
      record_id: z.string().describe('Record ID'),
      include_data: z.boolean().optional().describe('Include encrypted_data and delegate_payloads in response'),
    },
    async (params, extra) => {
      await getAuthFromExtra(extra); // Require auth

      const decoded = nip19.decode(params.app_npub);
      if (decoded.type !== 'npub') throw new Error('Invalid app_npub');
      const appPubkey = decoded.data as string;

      const result = await recordsService.getRecordHistory(
        appPubkey,
        params.record_id,
        params.include_data
      );
      if (!result) {
        throw new Error('Record not found');
      }
      return jsonContent(result);
    }
  );
}

/**
 * Start the CVM transport (MCP over Nostr)
 */
export async function startCvmTransport() {
  const config = getConfig();

  if (mcpServer) {
    console.warn('CVM transport already running');
    return;
  }

  console.log('Initializing CVM transport...');

  // Create the MCP server
  mcpServer = new McpServer({
    name: 'superbased-service',
    version: '0.1.0',
  });

  // Register all tools
  registerTools(mcpServer);

  // Create signer from server private key
  const signer = new PrivateKeySigner(
    bytesToHex(config.serverPrivateKey)
  );

  // Create relay pool
  const relayHandler = new ApplesauceRelayPool(config.nostrRelays);

  // Create the Nostr transport
  transport = new NostrServerTransport({
    signer,
    relayHandler,
    injectClientPubkey: true, // Critical: injects client pubkey into tool calls
  });

  // Patch the transport to inject authInfo from clientPubkey
  const originalStart = transport.start.bind(transport);
  transport.start = async function () {
    await originalStart();

    // Get the message handler
    const mcpHandler = this.onmessage as ((message: unknown, extra?: unknown) => void) | undefined;

    // Wrap it to inject authInfo
    this.onmessage = ((message: unknown, extra?: unknown) => {
      // Extract clientPubkey from _meta
      const params = (message as { params?: { _meta?: { clientPubkey?: string } } }).params;
      const clientPubkey = params?._meta?.clientPubkey;

      if (clientPubkey) {
        // Inject as authInfo for tool handlers
        const enhancedExtra = {
          ...(extra as object),
          authInfo: { pubkey: clientPubkey },
        };
        mcpHandler?.(message, enhancedExtra);
      } else {
        mcpHandler?.(message, extra);
      }
    }) as typeof this.onmessage;
  };

  // Connect the MCP server to the transport
  await mcpServer.connect(transport);

  console.log(`CVM transport started`);
  console.log(`  Server pubkey: ${config.serverPublicKey}`);
  console.log(`  Server npub: ${nip19.npubEncode(config.serverPublicKey)}`);
  console.log(`  Relays: ${config.nostrRelays.join(', ')}`);

  return {
    mcpServer,
    transport,
  };
}

/**
 * Stop the CVM transport
 */
export async function stopCvmTransport() {
  if (transport) {
    await transport.close();
    transport = null;
  }
  mcpServer = null;
  console.log('CVM transport stopped');
}

/**
 * Check if CVM transport is running
 */
export function isCvmRunning(): boolean {
  return mcpServer !== null;
}

/**
 * Get the MCP server instance (for testing)
 */
export function getMcpServer(): McpServer | null {
  return mcpServer;
}
