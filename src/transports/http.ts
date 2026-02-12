import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { nip19 } from 'nostr-tools';
import { getConfig } from '../config';
import { verifyNip98, createAuthContext } from '../auth/nip98';
import { getOrCreateFluxbaseUser, generateFluxbaseJwt } from '../auth/user-mapping';
import { FluxbaseClient } from '../fluxbase/client';
import { appsService } from '../services/apps';
import { recordsService } from '../services/records';
import { usersService } from '../services/users';
import { delegationsService } from '../services/delegations';
import type { AuthContext, SyncRecordInput, CreateDelegationInput } from '../types';

/**
 * Resolve app npub to pubkey hex.
 * App registration is optional - any valid npub can be used as a namespace.
 */
function resolveAppPubkey(appNpub: string): { pubkey: string } {
  try {
    const decoded = nip19.decode(appNpub);
    if (decoded.type !== 'npub') {
      throw new Error('Invalid npub: wrong type');
    }
    return { pubkey: decoded.data as string };
  } catch (err) {
    throw new Error(`Invalid app npub format: ${err}`);
  }
}

// Extend Hono context with auth
declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

/**
 * Create the HTTP server with all routes
 */
export function createHttpServer() {
  const app = new Hono();
  const config = getConfig();

  // Middleware: CORS
  app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }));

  // Middleware: Logger
  app.use('*', logger());

  // Health check (no auth required)
  app.get('/health', async (c) => {
    const config = getConfig();
    const client = new FluxbaseClient();
    const health = await client.health();
    return c.json({
      status: 'ok',
      adaptor: 'flux-adaptor',
      serverNpub: nip19.npubEncode(config.serverPublicKey),
      fluxbase: health,
    });
  });

  // NIP-98 Auth middleware for protected routes
  const authMiddleware = async (c: any, next: any) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader) {
      return c.json({ error: 'Missing Authorization header' }, 401);
    }

    // Check for Bearer token (SERVICE_TOKEN auth)
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7); // Remove 'Bearer ' prefix

      if (config.serviceToken && token === config.serviceToken) {
        // Service token auth - create admin context
        const auth: AuthContext = {
          pubkey: 'service',
          npub: 'service',
          isAdmin: true,
          isServiceToken: true,
        };
        c.set('auth', auth);
        await next();
        return;
      }

      return c.json({ error: 'Invalid service token' }, 401);
    }

    // Get full URL for verification
    const url = c.req.url;
    const method = c.req.method;

    // Get body for POST/PUT/PATCH requests
    let body: string | undefined;
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      try {
        body = await c.req.text();
        // Re-create the request with the body for downstream handlers
        // Note: Hono caches the body, so we need to handle this carefully
      } catch {
        body = undefined;
      }
    }

    // Verify NIP-98
    const result = verifyNip98(authHeader, url, method, body);

    if (!result.valid || !result.pubkey) {
      return c.json({ error: result.error || 'Authentication failed' }, 401);
    }

    // Create auth context
    let auth = createAuthContext(result.pubkey);

    // Get or create Fluxbase user
    auth = await getOrCreateFluxbaseUser(auth);

    // Generate JWT for Fluxbase requests
    auth.fluxbaseJwt = await generateFluxbaseJwt(auth) ?? undefined;

    // Store auth context
    c.set('auth', auth);

    await next();
  };

  // ==================== Auth Routes ====================

  app.get('/auth/me', authMiddleware, async (c) => {
    const auth = c.get('auth');
    return c.json({
      npub: auth.npub,
      pubkey: auth.pubkey,
      isAdmin: auth.isAdmin,
      fluxbaseUserId: auth.fluxbaseUserId,
    });
  });

  // ==================== Database Routes ====================

  // Query
  app.get('/db/:table', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const table = c.req.param('table');
    const query = c.req.query();

    const client = FluxbaseClient.forAuth(auth);

    // Parse query params into filter object
    const filter: Record<string, unknown> = {};
    const select = query.select;
    const order = query.order;
    const limit = query.limit ? parseInt(query.limit) : undefined;
    const offset = query.offset ? parseInt(query.offset) : undefined;

    // Everything else is a filter
    for (const [key, value] of Object.entries(query)) {
      if (!['select', 'order', 'limit', 'offset'].includes(key)) {
        filter[key] = value;
      }
    }

    const result = await client.query({
      table,
      select,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      order: order ? { column: order.replace(/\.(asc|desc)$/, ''), ascending: !order.endsWith('.desc') } : undefined,
      limit,
      offset,
    });

    if (result.error) {
      return c.json({ error: result.error }, 400);
    }

    return c.json(result.data);
  });

  // Insert
  app.post('/db/:table', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const table = c.req.param('table');

    let data: unknown;
    try {
      data = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const client = FluxbaseClient.forAuth(auth);
    const result = await client.insert({ table, data: data as Record<string, unknown> });

    if (result.error) {
      return c.json({ error: result.error }, 400);
    }

    return c.json(result.data, 201);
  });

  // Update
  app.patch('/db/:table', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const table = c.req.param('table');
    const query = c.req.query();

    let data: unknown;
    try {
      data = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    // Build filter from query params
    const filter: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(query)) {
      filter[key] = value;
    }

    if (Object.keys(filter).length === 0) {
      return c.json({ error: 'Filter required for update' }, 400);
    }

    const client = FluxbaseClient.forAuth(auth);
    const result = await client.update({ table, filter, data: data as Record<string, unknown> });

    if (result.error) {
      return c.json({ error: result.error }, 400);
    }

    return c.json(result.data);
  });

  // Delete
  app.delete('/db/:table', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const table = c.req.param('table');
    const query = c.req.query();

    // Build filter from query params
    const filter: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(query)) {
      filter[key] = value;
    }

    if (Object.keys(filter).length === 0) {
      return c.json({ error: 'Filter required for delete' }, 400);
    }

    const client = FluxbaseClient.forAuth(auth);
    const result = await client.delete({ table, filter });

    if (result.error) {
      return c.json({ error: result.error }, 400);
    }

    return c.json({ success: true });
  });

  // ==================== Storage Routes ====================

  // Upload
  app.post('/storage/:bucket/*', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const bucket = c.req.param('bucket');
    const path = c.req.path.replace(`/storage/${bucket}/`, '');
    const contentType = c.req.header('Content-Type') || 'application/octet-stream';

    const body = await c.req.arrayBuffer();
    const content = new Uint8Array(body);

    const client = FluxbaseClient.forAuth(auth);
    const result = await client.uploadFile(bucket, path, content, contentType);

    if (result.error) {
      return c.json({ error: result.error }, 400);
    }

    return c.json(result.data, 201);
  });

  // Download
  app.get('/storage/:bucket/*', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const bucket = c.req.param('bucket');
    const path = c.req.path.replace(`/storage/${bucket}/`, '');

    const client = FluxbaseClient.forAuth(auth);
    const result = await client.downloadFile(bucket, path);

    if (result.error) {
      return c.json({ error: result.error }, 400);
    }

    return new Response(result.data, {
      headers: {
        'Content-Type': result.contentType || 'application/octet-stream',
      },
    });
  });

  // List
  app.get('/storage/:bucket', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const bucket = c.req.param('bucket');
    const { prefix, limit, offset } = c.req.query();

    const client = FluxbaseClient.forAuth(auth);
    const result = await client.listFiles(
      bucket,
      prefix,
      limit ? parseInt(limit) : undefined,
      offset ? parseInt(offset) : undefined
    );

    if (result.error) {
      return c.json({ error: result.error }, 400);
    }

    return c.json(result.data);
  });

  // Delete file
  app.delete('/storage/:bucket/*', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const bucket = c.req.param('bucket');
    const path = c.req.path.replace(`/storage/${bucket}/`, '');

    const client = FluxbaseClient.forAuth(auth);
    const result = await client.deleteFile(bucket, path);

    if (result.error) {
      return c.json({ error: result.error }, 400);
    }

    return c.json({ success: true });
  });

  // ==================== Functions Routes ====================

  app.post('/functions/:name', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const name = c.req.param('name');

    let payload: unknown;
    try {
      const text = await c.req.text();
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      payload = undefined;
    }

    const client = FluxbaseClient.forAuth(auth);
    const result = await client.invokeFunction(name, payload);

    if (result.error) {
      return c.json({ error: result.error }, 400);
    }

    return c.json(result.data);
  });

  // ==================== App Registry Routes ====================

  // Register new app (requires attestation signed by app owner)
  app.post('/apps/register', authMiddleware, async (c) => {
    const auth = c.get('auth');

    let body: { name: string; attestation: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.name || !body.attestation) {
      return c.json({ error: 'name and attestation required' }, 400);
    }

    try {
      const result = await appsService.registerApp(auth, body.name, body.attestation);
      return c.json(result, 201);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  // List apps owned by authenticated user
  app.get('/apps', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const apps = await appsService.listApps(auth.pubkey);
    return c.json({ apps });
  });

  // Get app info
  app.get('/apps/:appNpub', authMiddleware, async (c) => {
    const appNpub = c.req.param('appNpub');
    const appInfo = await appsService.getAppByNpub(appNpub);
    if (!appInfo) {
      return c.json({ error: 'App not found' }, 404);
    }
    return c.json(appInfo);
  });

  // Generate token for app (only app owner can generate)
  app.post('/apps/:appNpub/token', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');

    let options: { relay?: string; http?: string } = {};
    try {
      options = await c.req.json();
    } catch {
      // Optional body
    }

    try {
      const token = await appsService.generateToken(auth, appNpub, options);
      return c.json({ token });
    } catch (err) {
      return c.json({ error: String(err) }, 403);
    }
  });

  // ==================== Delegation Routes ====================

  // Grant delegation to another pubkey
  app.post('/apps/:appNpub/delegate', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');

    // Check user access
    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) {
      return c.json({ error: access.reason || 'Access denied' }, 403);
    }

    // Resolve app npub
    let appPubkey: string;
    try {
      const resolved = resolveAppPubkey(appNpub);
      appPubkey = resolved.pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    let input: CreateDelegationInput;
    try {
      input = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!input.delegate_npub || !input.permissions) {
      return c.json({ error: 'delegate_npub and permissions required' }, 400);
    }

    try {
      const result = await delegationsService.grantDelegation(appPubkey, auth, input);
      return c.json(result, result.created ? 201 : 200);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  // List delegations granted by the authenticated user
  app.get('/apps/:appNpub/delegations', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');

    // Check user access
    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) {
      return c.json({ error: access.reason || 'Access denied' }, 403);
    }

    // Resolve app npub
    let appPubkey: string;
    try {
      const resolved = resolveAppPubkey(appNpub);
      appPubkey = resolved.pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    try {
      const delegations = await delegationsService.listDelegations(appPubkey, auth);
      return c.json({ delegations });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Revoke a delegation
  app.delete('/apps/:appNpub/delegate/:delegateNpub', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');
    const delegateNpub = c.req.param('delegateNpub');

    // Check user access
    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) {
      return c.json({ error: access.reason || 'Access denied' }, 403);
    }

    // Resolve app npub
    let appPubkey: string;
    try {
      const resolved = resolveAppPubkey(appNpub);
      appPubkey = resolved.pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    try {
      const revoked = await delegationsService.revokeDelegation(appPubkey, auth, delegateNpub);
      if (revoked) {
        return c.json({ success: true });
      } else {
        return c.json({ error: 'Delegation not found or already revoked' }, 404);
      }
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  // ==================== Record Sync Routes ====================

  // Sync records
  app.post('/records/:appNpub/sync', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');

    // Check user access (balance > 0 OR whitelist = true)
    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) {
      return c.json({ error: access.reason || 'Access denied' }, 403);
    }

    // Resolve app npub (registration is optional)
    let appPubkey: string;
    try {
      const resolved = resolveAppPubkey(appNpub);
      appPubkey = resolved.pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    let records: SyncRecordInput[];
    try {
      const body = await c.req.json();
      records = body.records;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!Array.isArray(records)) {
      return c.json({ error: 'records array required' }, 400);
    }

    try {
      const result = await recordsService.syncRecords(appPubkey, auth, records);
      return c.json(result);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // ==================== DER Delegate Endpoint ====================

  // Fetch records delegated to the caller (DER pull endpoint)
  app.get('/records/:appNpub/delegated', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');
    const { since, collection, limit, cursor, owner } = c.req.query();

    if (!owner) {
      return c.json({ error: 'owner query parameter is required (hex pubkey)' }, 400);
    }

    // Check user access
    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) {
      return c.json({ error: access.reason || 'Access denied' }, 403);
    }

    // Resolve app npub
    let appPubkey: string;
    try {
      const resolved = resolveAppPubkey(appNpub);
      appPubkey = resolved.pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    try {
      const result = await recordsService.fetchDelegatedRecords(
        appPubkey,
        auth.pubkey,
        {
          since,
          collection,
          limit: limit ? parseInt(limit) : undefined,
          cursor,
          ownerPubkey: owner,
        }
      );
      return c.json(result);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // ==================== Record Fetch Routes ====================

  // Fetch records (own records or delegated records with ?delegate=true)
  app.get('/records/:appNpub/fetch', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');
    const { collection, since, delegate } = c.req.query();

    // Check user access (balance > 0 OR whitelist = true)
    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) {
      return c.json({ error: access.reason || 'Access denied' }, 403);
    }

    // Resolve app npub (registration is optional)
    let appPubkey: string;
    try {
      const resolved = resolveAppPubkey(appNpub);
      appPubkey = resolved.pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    try {
      // If delegate=true, fetch records where user is a delegate
      if (delegate === 'true') {
        const result = await recordsService.fetchRecordsForDelegate(
          appPubkey,
          auth.pubkey,
          collection,
          since
        );
        return c.json(result);
      }

      // Default: fetch user's own records
      const result = await recordsService.fetchRecords(
        appPubkey,
        auth,
        collection,
        since
      );
      return c.json(result);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Delete records
  app.delete('/records/:appNpub', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');
    const { record_ids } = c.req.query();

    // Check user access (balance > 0 OR whitelist = true)
    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) {
      return c.json({ error: access.reason || 'Access denied' }, 403);
    }

    // Resolve app npub (registration is optional)
    let appPubkey: string;
    try {
      const resolved = resolveAppPubkey(appNpub);
      appPubkey = resolved.pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    const ids = record_ids?.split(',') || [];
    if (!ids.length) {
      return c.json({ error: 'record_ids query parameter required' }, 400);
    }

    try {
      const deleted = await recordsService.deleteRecords(appPubkey, auth, ids);
      return c.json({ deleted });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  return app;
}

/**
 * Start the HTTP server
 */
export async function startHttpServer() {
  const config = getConfig();
  const app = createHttpServer();

  console.log(`Starting HTTP server on ${config.httpHost}:${config.httpPort}`);

  return Bun.serve({
    port: config.httpPort,
    hostname: config.httpHost,
    fetch: app.fetch,
  });
}
