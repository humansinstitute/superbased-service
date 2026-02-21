import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { nip19 } from 'nostr-tools';
import { getConfig } from '../config';
import { verifyNip98, createAuthContext } from '../auth/nip98';
import { getDb } from '../db/postgres';
import { appsService } from '../services/apps';
import { recordsService } from '../services/records';
import { usersService } from '../services/users';
import { delegationsService } from '../services/delegations';
import { pushService } from '../services/push';
import type {
  AuthContext,
  SyncRecordInputV3,
  CreateDelegationInput,
  PushSubscriptionUpsertInput,
  PushSubscriptionDeleteInput,
} from '../types';

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
    let dbHealthy = false;
    try {
      const sql = getDb();
      await sql`SELECT 1`;
      dbHealthy = true;
    } catch {
      // db unreachable
    }
    return c.json({
      status: dbHealthy ? 'ok' : 'degraded',
      adaptor: 'flux-adaptor',
      serverNpub: nip19.npubEncode(config.serverPublicKey),
      postgres: { healthy: dbHealthy },
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
    const auth = createAuthContext(result.pubkey);

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
    });
  });

  // ==================== Database Routes (stubbed) ====================

  app.get('/db/:table', authMiddleware, async (c) => {
    return c.json({ error: 'Not implemented — direct DB proxy removed' }, 501);
  });

  app.post('/db/:table', authMiddleware, async (c) => {
    return c.json({ error: 'Not implemented — direct DB proxy removed' }, 501);
  });

  app.patch('/db/:table', authMiddleware, async (c) => {
    return c.json({ error: 'Not implemented — direct DB proxy removed' }, 501);
  });

  app.delete('/db/:table', authMiddleware, async (c) => {
    return c.json({ error: 'Not implemented — direct DB proxy removed' }, 501);
  });

  // ==================== Storage Routes (stubbed) ====================

  app.post('/storage/:bucket/*', authMiddleware, async (c) => {
    return c.json({ error: 'Not implemented — storage proxy removed' }, 501);
  });

  app.get('/storage/:bucket/*', authMiddleware, async (c) => {
    return c.json({ error: 'Not implemented — storage proxy removed' }, 501);
  });

  app.get('/storage/:bucket', authMiddleware, async (c) => {
    return c.json({ error: 'Not implemented — storage proxy removed' }, 501);
  });

  app.delete('/storage/:bucket/*', authMiddleware, async (c) => {
    return c.json({ error: 'Not implemented — storage proxy removed' }, 501);
  });

  // ==================== Functions Routes (stubbed) ====================

  app.post('/functions/:name', authMiddleware, async (c) => {
    return c.json({ error: 'Not implemented — functions proxy removed' }, 501);
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

  // ==================== Record Sync Routes (v3) ====================

  // Register or update Web Push subscription
  app.get('/apps/:appNpub/push/config', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');
    const config = getConfig();

    // Check user access
    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) {
      return c.json({ error: access.reason || 'Access denied' }, 403);
    }

    let appPubkey: string;
    try {
      const resolved = resolveAppPubkey(appNpub);
      appPubkey = resolved.pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    // Ensure app namespace is valid even if unused in this handler
    if (!appPubkey) {
      return c.json({ error: 'Invalid app namespace' }, 400);
    }

    return c.json({
      enabled: pushService.enabled(),
      vapid_public_key: config.pushVapidPublicKey || null,
      collections: ['chat_messages'],
    });
  });

  // Register or update Web Push subscription
  app.post('/apps/:appNpub/push/subscribe', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');

    if (!pushService.enabled()) {
      return c.json({ error: 'Push notifications are disabled on this server' }, 503);
    }

    // Check user access
    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) {
      return c.json({ error: access.reason || 'Access denied' }, 403);
    }

    let appPubkey: string;
    try {
      const resolved = resolveAppPubkey(appNpub);
      appPubkey = resolved.pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    let input: PushSubscriptionUpsertInput;
    try {
      input = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!input.subscription?.endpoint || !input.subscription?.keys?.p256dh || !input.subscription?.keys?.auth) {
      return c.json({ error: 'Invalid PushSubscription payload' }, 400);
    }

    await pushService.upsertSubscription(
      appPubkey,
      auth.pubkey,
      input.subscription,
      input.collections || [],
      input.device_id,
      c.req.header('User-Agent')
    );

    return c.json({ success: true });
  });

  // Remove Web Push subscription
  app.post('/apps/:appNpub/push/unsubscribe', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');

    // Check user access
    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) {
      return c.json({ error: access.reason || 'Access denied' }, 403);
    }

    let appPubkey: string;
    try {
      const resolved = resolveAppPubkey(appNpub);
      appPubkey = resolved.pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    let input: PushSubscriptionDeleteInput;
    try {
      input = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!input.endpoint) {
      return c.json({ error: 'endpoint required' }, 400);
    }

    const removed = await pushService.deleteSubscription(appPubkey, auth.pubkey, input.endpoint);
    return c.json({ success: true, removed });
  });

  // List Web Push subscriptions for current user/app
  app.get('/apps/:appNpub/push/subscriptions', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');

    // Check user access
    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) {
      return c.json({ error: access.reason || 'Access denied' }, 403);
    }

    let appPubkey: string;
    try {
      const resolved = resolveAppPubkey(appNpub);
      appPubkey = resolved.pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    const subscriptions = await pushService.listSubscriptions(appPubkey, auth.pubkey);
    return c.json({ subscriptions });
  });

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

    let records: SyncRecordInputV3[];
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
      if (result.outcomes?.length > 0) {
        await pushService.notifyOnSyncOutcomes(appPubkey, auth.pubkey, result.outcomes);
      }
      return c.json({
        synced: result.synced,
        created: result.created,
        updated: result.updated,
        rejected: result.rejected,
      });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Fetch own records
  app.get('/records/:appNpub/fetch', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');
    const { collection, since } = c.req.query();

    // Check user access
    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) {
      return c.json({ error: access.reason || 'Access denied' }, 403);
    }

    let appPubkey: string;
    try {
      const resolved = resolveAppPubkey(appNpub);
      appPubkey = resolved.pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    try {
      const result = await recordsService.fetchRecords(appPubkey, auth, collection, since);
      return c.json(result);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Fetch records delegated to the caller
  app.get('/records/:appNpub/delegated', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');
    const { collection, owner, limit: limitStr, cursor } = c.req.query();

    // Check user access
    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) {
      return c.json({ error: access.reason || 'Access denied' }, 403);
    }

    let appPubkey: string;
    try {
      const resolved = resolveAppPubkey(appNpub);
      appPubkey = resolved.pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    try {
      const limit = limitStr ? Math.min(parseInt(limitStr, 10), 100) : undefined;
      const result = await recordsService.fetchDelegatedRecords(
        appPubkey,
        auth.pubkey,
        collection,
        owner,
        limit,
        cursor
      );
      return c.json(result);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Record history
  app.get('/records/:appNpub/history/:recordId', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');
    const recordId = c.req.param('recordId');
    const { include_data } = c.req.query();

    // Check user access
    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) {
      return c.json({ error: access.reason || 'Access denied' }, 403);
    }

    let appPubkey: string;
    try {
      const resolved = resolveAppPubkey(appNpub);
      appPubkey = resolved.pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    try {
      const result = await recordsService.getRecordHistory(
        appPubkey,
        recordId,
        include_data === 'true'
      );
      if (!result) {
        return c.json({ error: 'Record not found' }, 404);
      }
      return c.json(result);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Delete record (inserts deleted version)
  app.delete('/records/:appNpub', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');
    const { record_id } = c.req.query();

    // Check user access
    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) {
      return c.json({ error: access.reason || 'Access denied' }, 403);
    }

    let appPubkey: string;
    try {
      const resolved = resolveAppPubkey(appNpub);
      appPubkey = resolved.pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    if (!record_id) {
      return c.json({ error: 'record_id query parameter required' }, 400);
    }

    try {
      const result = await recordsService.deleteRecord(appPubkey, auth, record_id);
      if (!result) {
        return c.json({ error: 'Record not found or already deleted' }, 404);
      }
      return c.json(result);
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
