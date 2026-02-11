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
import { getOrCreateFluxbaseUser, generateFluxbaseJwt } from '../auth/user-mapping';
import { FluxbaseClient } from '../fluxbase/client';
import { appsService } from '../services/apps';
import { recordsService } from '../services/records';
import type { AuthContext, SyncRecordInput } from '../types';

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

  // Create auth context and set up Fluxbase user
  let auth = createAuthContext(pubkeyHex);
  auth = await getOrCreateFluxbaseUser(auth);
  auth.fluxbaseJwt = await generateFluxbaseJwt(auth) ?? undefined;

  return auth;
}

/**
 * Helper to create JSON content response for MCP
 */
function jsonContent(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  };
}

/**
 * Register all MCP tools
 */
function registerTools(server: McpServer) {
  // Health check (no auth required)
  server.tool(
    'health',
    'Check service health and Fluxbase connection',
    {},
    async () => {
      const client = new FluxbaseClient();
      const health = await client.health();
      return jsonContent({
        status: 'ok',
        adaptor: 'flux-adaptor',
        fluxbase: health,
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
        fluxbaseUserId: auth.fluxbaseUserId,
      });
    }
  );

  // Database - query
  server.tool(
    'db_query',
    'Query records from a database table',
    {
      table: z.string().describe('Table name to query'),
      select: z.string().optional().describe('Columns to select (comma-separated)'),
      filter: z.record(z.unknown()).optional().describe('Filter conditions'),
      order: z.object({
        column: z.string(),
        ascending: z.boolean().optional(),
      }).optional().describe('Order by column'),
      limit: z.number().optional().describe('Maximum records to return'),
      offset: z.number().optional().describe('Number of records to skip'),
    },
    async (params, extra) => {
      const auth = await getAuthFromExtra(extra);
      const client = FluxbaseClient.forAuth(auth);
      const result = await client.query(params);
      if (result.error) {
        throw new Error(result.error);
      }
      return jsonContent(result.data);
    }
  );

  // Database - insert
  server.tool(
    'db_insert',
    'Insert records into a database table',
    {
      table: z.string().describe('Table name'),
      data: z.union([
        z.record(z.unknown()),
        z.array(z.record(z.unknown())),
      ]).describe('Record(s) to insert'),
    },
    async (params, extra) => {
      const auth = await getAuthFromExtra(extra);
      const client = FluxbaseClient.forAuth(auth);
      const result = await client.insert({
        table: params.table,
        data: params.data as Record<string, unknown>,
      });
      if (result.error) {
        throw new Error(result.error);
      }
      return jsonContent(result.data);
    }
  );

  // Database - update
  server.tool(
    'db_update',
    'Update records in a database table',
    {
      table: z.string().describe('Table name'),
      filter: z.record(z.unknown()).describe('Filter to match records'),
      data: z.record(z.unknown()).describe('Fields to update'),
    },
    async (params, extra) => {
      const auth = await getAuthFromExtra(extra);
      const client = FluxbaseClient.forAuth(auth);
      const result = await client.update({
        table: params.table,
        filter: params.filter,
        data: params.data,
      });
      if (result.error) {
        throw new Error(result.error);
      }
      return jsonContent(result.data);
    }
  );

  // Database - delete
  server.tool(
    'db_delete',
    'Delete records from a database table',
    {
      table: z.string().describe('Table name'),
      filter: z.record(z.unknown()).describe('Filter to match records to delete'),
    },
    async (params, extra) => {
      const auth = await getAuthFromExtra(extra);
      const client = FluxbaseClient.forAuth(auth);
      const result = await client.delete({
        table: params.table,
        filter: params.filter,
      });
      if (result.error) {
        throw new Error(result.error);
      }
      return jsonContent({ success: true });
    }
  );

  // Storage - upload
  server.tool(
    'storage_upload',
    'Upload a file to storage (content must be base64 encoded)',
    {
      bucket: z.string().describe('Storage bucket name'),
      path: z.string().describe('File path within bucket'),
      content: z.string().describe('Base64 encoded file content'),
      contentType: z.string().optional().describe('MIME type of the file'),
    },
    async (params, extra) => {
      const auth = await getAuthFromExtra(extra);
      const client = FluxbaseClient.forAuth(auth);

      // Decode base64 content
      const decoded = Uint8Array.from(atob(params.content), c => c.charCodeAt(0));

      const result = await client.uploadFile(
        params.bucket,
        params.path,
        decoded,
        params.contentType || 'application/octet-stream'
      );
      if (result.error) {
        throw new Error(result.error);
      }
      return jsonContent(result.data);
    }
  );

  // Storage - download
  server.tool(
    'storage_download',
    'Download a file from storage (returns base64 encoded content)',
    {
      bucket: z.string().describe('Storage bucket name'),
      path: z.string().describe('File path within bucket'),
    },
    async (params, extra) => {
      const auth = await getAuthFromExtra(extra);
      const client = FluxbaseClient.forAuth(auth);

      const result = await client.downloadFile(params.bucket, params.path);
      if (result.error) {
        throw new Error(result.error);
      }

      // Encode to base64 for transport
      const base64 = btoa(String.fromCharCode(...(result.data || [])));
      return jsonContent({
        content: base64,
        contentType: result.contentType,
      });
    }
  );

  // Storage - list
  server.tool(
    'storage_list',
    'List files in a storage bucket',
    {
      bucket: z.string().describe('Storage bucket name'),
      prefix: z.string().optional().describe('Filter by path prefix'),
      limit: z.number().optional().describe('Maximum files to return'),
      offset: z.number().optional().describe('Number of files to skip'),
    },
    async (params, extra) => {
      const auth = await getAuthFromExtra(extra);
      const client = FluxbaseClient.forAuth(auth);

      const result = await client.listFiles(
        params.bucket,
        params.prefix,
        params.limit,
        params.offset
      );
      if (result.error) {
        throw new Error(result.error);
      }
      return jsonContent(result.data);
    }
  );

  // Storage - delete
  server.tool(
    'storage_delete',
    'Delete a file from storage',
    {
      bucket: z.string().describe('Storage bucket name'),
      path: z.string().describe('File path to delete'),
    },
    async (params, extra) => {
      const auth = await getAuthFromExtra(extra);
      const client = FluxbaseClient.forAuth(auth);

      const result = await client.deleteFile(params.bucket, params.path);
      if (result.error) {
        throw new Error(result.error);
      }
      return jsonContent({ success: true });
    }
  );

  // Functions - invoke
  server.tool(
    'function_invoke',
    'Invoke a Fluxbase edge function',
    {
      name: z.string().describe('Function name to invoke'),
      payload: z.unknown().optional().describe('Payload to pass to the function'),
    },
    async (params, extra) => {
      const auth = await getAuthFromExtra(extra);
      const client = FluxbaseClient.forAuth(auth);

      const result = await client.invokeFunction(params.name, params.payload);
      if (result.error) {
        throw new Error(result.error);
      }
      return jsonContent(result.data);
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

  // ==================== Record Sync Tools ====================

  // Sync records
  server.tool(
    'sync_records',
    'Sync encrypted records to app storage',
    {
      app_npub: z.string().describe('App npub to sync to'),
      records: z.array(z.object({
        record_id: z.string(),
        collection: z.string().optional(),
        encrypted_data: z.string(),
        metadata: z.record(z.unknown()).optional(),
      })).describe('Records to sync'),
    },
    async (params, extra) => {
      const auth = await getAuthFromExtra(extra);
      const appInfo = await appsService.getAppByNpub(params.app_npub);
      if (!appInfo) {
        throw new Error('App not found');
      }

      const result = await recordsService.syncRecords(
        appInfo.app_pubkey,
        auth,
        params.records as SyncRecordInput[]
      );
      return jsonContent(result);
    }
  );

  // Fetch records
  server.tool(
    'fetch_records',
    'Fetch encrypted records from app storage',
    {
      app_npub: z.string().describe('App npub to fetch from'),
      collection: z.string().optional().describe('Filter by collection'),
      since: z.string().optional().describe('Fetch records updated after this ISO timestamp'),
    },
    async (params, extra) => {
      const auth = await getAuthFromExtra(extra);
      const appInfo = await appsService.getAppByNpub(params.app_npub);
      if (!appInfo) {
        throw new Error('App not found');
      }

      const result = await recordsService.fetchRecords(
        appInfo.app_pubkey,
        auth,
        params.collection,
        params.since
      );
      return jsonContent(result);
    }
  );

  // Delete records
  server.tool(
    'delete_records',
    'Delete records from app storage',
    {
      app_npub: z.string().describe('App npub'),
      record_ids: z.array(z.string()).describe('Record IDs to delete'),
    },
    async (params, extra) => {
      const auth = await getAuthFromExtra(extra);
      const appInfo = await appsService.getAppByNpub(params.app_npub);
      if (!appInfo) {
        throw new Error('App not found');
      }

      const deleted = await recordsService.deleteRecords(
        appInfo.app_pubkey,
        auth,
        params.record_ids
      );
      return jsonContent({ deleted });
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
    name: 'flux-adaptor',
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
