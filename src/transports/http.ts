import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { nip19 } from 'nostr-tools';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getConfig } from '../config';
import { verifyNip98, createAuthContext } from '../auth/nip98';
import { getDb } from '../db/postgres';
import { appsService } from '../services/apps';
import { recordsService } from '../services/records';
import { usersService } from '../services/users';
import { delegationsService } from '../services/delegations';
import { groupsService } from '../services/groups';
import { pushService } from '../services/push';
import { usageReportService } from '../services/usage-report';
import { storageService } from '../services/storage';
import { renderConnectionUiHtml, renderUiLoginHtml, renderUsageReportUiHtml } from './webui';
import type {
  AuthContext,
  AddGroupMemberInput,
  CreateGroupInput,
  CreateGroupRequestInput,
  SyncRecordInputV3,
  CreateDelegationInput,
  PushSubscriptionUpsertInput,
  PushSubscriptionDeleteInput,
  ResolveGroupRequestInput,
  StoragePrepareUploadInput,
  StorageCompleteUploadInput,
} from '../types';

const qrBundleFile = Bun.file(new URL('./assets/qrcode.bundle.mjs', import.meta.url));

interface UiSessionPayload {
  pubkey: string;
  exp: number;
}

const UI_TABLE_DEFAULT_LIMIT = 25;
const UI_TABLE_MAX_LIMIT = 200;
const UI_TABLE_NAME_PATTERN = /^superbased_[a-z0-9_]+$/;

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function fromB64url(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function getSessionSecret(config: ReturnType<typeof getConfig>): string {
  return config.serviceToken || Buffer.from(config.serverPrivateKey).toString('hex');
}

function signUiSession(payloadEncoded: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadEncoded).digest('base64url');
}

function createUiSessionToken(pubkey: string, config: ReturnType<typeof getConfig>): string {
  const payload: UiSessionPayload = {
    pubkey,
    exp: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60),
  };
  const payloadEncoded = b64url(JSON.stringify(payload));
  const sig = signUiSession(payloadEncoded, getSessionSecret(config));
  return `${payloadEncoded}.${sig}`;
}

function parseCookieValue(cookieHeader: string | undefined, key: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === key) return rest.join('=');
  }
  return null;
}

function verifyUiSessionToken(token: string | null, config: ReturnType<typeof getConfig>): UiSessionPayload | null {
  if (!token) return null;
  const [payloadEncoded, sig] = token.split('.');
  if (!payloadEncoded || !sig) return null;

  const expected = signUiSession(payloadEncoded, getSessionSecret(config));
  const expectedBuf = Buffer.from(expected);
  const sigBuf = Buffer.from(sig);
  if (expectedBuf.length !== sigBuf.length) return null;
  if (!timingSafeEqual(expectedBuf, sigBuf)) return null;

  try {
    const payload = JSON.parse(fromB64url(payloadEncoded)) as UiSessionPayload;
    const now = Math.floor(Date.now() / 1000);
    if (!payload.pubkey || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}

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

// App-less namespace: use server pubkey as a stable global namespace.
function resolveDefaultNamespacePubkey(): string {
  const config = getConfig();
  return config.serverPublicKey;
}

function safeNpubEncode(pubkey: string): string | null {
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return null;
  }
}

function parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseOffset(value: string | undefined): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function normalizeUiTableName(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!UI_TABLE_NAME_PATTERN.test(normalized)) return null;
  return normalized;
}

function toJsonSafeValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => toJsonSafeValue(entry));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonSafeValue(entry);
    }
    return out;
  }
  return value;
}

function getUiAdminFromCookie(c: any, config: ReturnType<typeof getConfig>): AuthContext | null {
  const token = parseCookieValue(c.req.header('Cookie'), 'sb_ui_session');
  const session = verifyUiSessionToken(token, config);
  if (!session) return null;
  const auth = createAuthContext(session.pubkey);
  return auth.isAdmin ? auth : null;
}

// Extend Hono context with auth
declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

function isNoisySuccessPath(path: string): boolean {
  if (/^\/records\/[^/]+\/sync$/.test(path)) return true;
  if (/^\/apps\/[^/]+\/push(\/|$)/.test(path)) return true;
  return false;
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

  // Middleware: request logging
  // Keep logs high-signal: log non-GET requests and any error responses,
  // except high-volume successful sync/push routes.
  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const method = c.req.method;
    const status = c.res.status;
    const path = c.req.path;
    const skipNoisySuccess = status < 400 && isNoisySuccessPath(path);
    if (!skipNoisySuccess && (method !== 'GET' || status >= 400)) {
      const ms = Date.now() - start;
      console.log(`${method} ${path} -> ${status} (${ms}ms)`);
    }
  });

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
      adaptor: 'superbased-service',
      serverNpub: nip19.npubEncode(config.serverPublicKey),
      postgres: { healthy: dbHealthy },
    });
  });

  // Admin UI (NIP-07 login required for report access)
  app.get('/ui', async (c) => {
    const auth = getUiAdminFromCookie(c, config);
    if (!auth) {
      return c.html(renderUiLoginHtml());
    }
    return c.html(renderUsageReportUiHtml());
  });

  // Legacy connection helper UI
  app.get('/ui/connect', async (c) => {
    return c.html(renderConnectionUiHtml());
  });

  app.post('/ui/auth/login', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader) return c.json({ error: 'Missing Authorization header' }, 401);
    const result = verifyNip98(authHeader, c.req.url, c.req.method);
    if (!result.valid || !result.pubkey) return c.json({ error: result.error || 'Authentication failed' }, 401);

    const auth = createAuthContext(result.pubkey);
    if (!auth.isAdmin) {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const token = createUiSessionToken(result.pubkey, config);
    c.header('Set-Cookie', `sb_ui_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
    return c.json({ ok: true, npub: auth.npub });
  });

  app.post('/ui/auth/logout', async (c) => {
    c.header('Set-Cookie', 'sb_ui_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return c.json({ ok: true });
  });

  app.get('/ui/report', async (c) => {
    try {
      const auth = getUiAdminFromCookie(c, config);
      if (!auth) return c.json({ error: 'Unauthorized' }, 401);

      const report = await usageReportService.getLatestReport(1000);
      const rows = report.rows.map((r) => ({
        captured_hour: r.captured_hour,
        user_pubkey: r.user_pubkey,
        user_npub: safeNpubEncode(r.user_pubkey),
        live_records: r.live_records,
        retained_rows: r.retained_rows,
        retained_bytes: r.retained_bytes,
        encrypted_data_bytes: r.encrypted_data_bytes,
        delegate_payload_bytes: r.delegate_payload_bytes,
      }));

      return c.json({ captured_hour: report.captured_hour, rows });
    } catch (err: any) {
      console.error('GET /ui/report failed:', err);
      return c.json({ error: err?.message || String(err) }, 500);
    }
  });

  app.get('/ui/tables', async (c) => {
    try {
      const auth = getUiAdminFromCookie(c, config);
      if (!auth) return c.json({ error: 'Unauthorized' }, 401);

      const sql = getDb();
      const tables = await sql`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename ~ '^superbased_[a-z0-9_]+$'
        ORDER BY tablename ASC
      `;

      return c.json({
        tables: tables.map((row: any) => row.tablename),
      });
    } catch (err: any) {
      console.error('GET /ui/tables failed:', err);
      return c.json({ error: err?.message || String(err) }, 500);
    }
  });

  app.get('/ui/tables/:table', async (c) => {
    try {
      const auth = getUiAdminFromCookie(c, config);
      if (!auth) return c.json({ error: 'Unauthorized' }, 401);

      const tableName = normalizeUiTableName(c.req.param('table'));
      if (!tableName) {
        return c.json({ error: 'Invalid table name' }, 400);
      }

      const limit = parsePositiveInt(c.req.query('limit'), UI_TABLE_DEFAULT_LIMIT, UI_TABLE_MAX_LIMIT);
      const offset = parseOffset(c.req.query('offset'));

      const sql = getDb();
      const existsRows = await sql`
        SELECT 1
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename = ${tableName}
        LIMIT 1
      `;
      if (existsRows.length === 0) {
        return c.json({ error: `Table not found: ${tableName}` }, 404);
      }

      const columnRows = await sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ${tableName}
        ORDER BY ordinal_position ASC
      `;
      const columns = columnRows.map((row: any) => String(row.column_name));
      const preferredSortColumns = ['updated_at', 'created_at', 'captured_hour', 'resolved_at', 'joined_at', 'id'];
      const orderByColumn = preferredSortColumns.find((name) => columns.includes(name)) || null;

      const totalRows = await sql`SELECT COUNT(*)::bigint AS total FROM ${sql(tableName)}`;
      const total = Number.parseInt(String(totalRows[0]?.total || '0'), 10) || 0;

      const rows = orderByColumn
        ? await sql`
            SELECT *
            FROM ${sql(tableName)}
            ORDER BY ${sql(orderByColumn)} DESC
            LIMIT ${limit}
            OFFSET ${offset}
          `
        : await sql`
            SELECT *
            FROM ${sql(tableName)}
            LIMIT ${limit}
            OFFSET ${offset}
          `;

      return c.json({
        table: tableName,
        columns,
        total,
        limit,
        offset,
        rows: toJsonSafeValue(rows),
      });
    } catch (err: any) {
      console.error('GET /ui/tables/:table failed:', err);
      return c.json({ error: err?.message || String(err) }, 500);
    }
  });

  // Static local QR module used by /ui (offline-friendly; no external CDN dependency)
  app.get('/ui/assets/qrcode.bundle.mjs', async (c) => {
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=3600');
    return c.body(await qrBundleFile.text());
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

  // Generate app-agnostic connection token
  app.post('/connect/token', async (c) => {

    let options: { relay?: string; http?: string; ttl_seconds?: number; scopes?: string[] } = {};
    try {
      options = await c.req.json();
    } catch {
      // Optional body
    }

    try {
      const token = await appsService.generateConnectionToken(options);
      return c.json({ token });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
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

  // ==================== Storage Routes ====================

  app.post('/storage/prepare-upload', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    let input: StoragePrepareUploadInput;
    try {
      input = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    try {
      const result = await storageService.prepareUpload(appPubkey, auth, input);
      return c.json(result, 201);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.post('/storage/complete-upload', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    let input: StorageCompleteUploadInput;
    try {
      input = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    try {
      const result = await storageService.completeUpload(appPubkey, auth, input);
      return c.json(result);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.get('/storage/list', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();
    const limit = Number(c.req.query('limit') ?? 100);

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    try {
      const objects = await storageService.listObjects(appPubkey, auth, limit);
      return c.json({ objects });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.get('/storage/usage', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    try {
      const usage = await storageService.getUsage(appPubkey, auth);
      return c.json(usage);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.get('/storage/:objectId/download-url', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();
    const objectId = c.req.param('objectId');

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    try {
      const result = await storageService.getDownloadUrl(appPubkey, auth, objectId);
      return c.json(result);
    } catch (err) {
      return c.json({ error: String(err) }, 404);
    }
  });

  app.delete('/storage/:objectId', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();
    const objectId = c.req.param('objectId');

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    try {
      const result = await storageService.deleteObject(appPubkey, auth, objectId);
      if (!result.deleted) return c.json({ error: 'Object not found' }, 404);
      return c.json(result);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
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

  // Grant delegation in default namespace (app-less mode)
  app.post('/delegations', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

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

  // List delegations in default namespace (app-less mode)
  app.get('/delegations', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    try {
      const delegations = await delegationsService.listDelegations(appPubkey, auth);
      return c.json({ delegations });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Revoke delegation in default namespace (app-less mode)
  app.delete('/delegations/:delegateNpub', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();
    const delegateNpub = c.req.param('delegateNpub');

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    try {
      const revoked = await delegationsService.revokeDelegation(appPubkey, auth, delegateNpub);
      if (!revoked) return c.json({ error: 'Delegation not found or already revoked' }, 404);
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

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

  // ==================== Group Routes ====================

  // Create group in default namespace (app-less mode)
  app.post('/groups', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    let input: CreateGroupInput;
    try {
      input = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    try {
      const group = await groupsService.createGroup(appPubkey, auth, input);
      return c.json({ group }, 201);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  // List groups where caller is a current member/delegate
  app.get('/groups', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    try {
      const groups = await groupsService.listMyGroups(appPubkey, auth);
      return c.json({ groups });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/groups/:groupId/members', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();
    const groupId = c.req.param('groupId');

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    try {
      const members = await groupsService.listGroupMembers(appPubkey, auth, groupId);
      return c.json({ members });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.post('/groups/:groupId/members', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();
    const groupId = c.req.param('groupId');

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    let input: AddGroupMemberInput;
    try {
      input = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    try {
      const result = await groupsService.addMember(appPubkey, auth, groupId, input);
      return c.json(result, result.created ? 201 : 200);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.delete('/groups/:groupId/members/:memberNpub', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();
    const groupId = c.req.param('groupId');
    const memberNpub = c.req.param('memberNpub');

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    try {
      const removed = await groupsService.removeMember(appPubkey, auth, groupId, memberNpub);
      if (!removed) return c.json({ error: 'Member not found or cannot be removed' }, 404);
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.post('/groups/:groupId/requests', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();
    const groupId = c.req.param('groupId');

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    let input: CreateGroupRequestInput;
    try {
      input = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    try {
      const result = await groupsService.createJoinRequest(appPubkey, auth, groupId, input);
      return c.json(result, result.created ? 201 : 200);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.get('/groups/:groupId/requests', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();
    const groupId = c.req.param('groupId');
    const { status } = c.req.query();

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    try {
      const requests = await groupsService.listJoinRequests(appPubkey, auth, groupId, status);
      return c.json({ requests });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.patch('/groups/:groupId/requests/:requestId', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();
    const groupId = c.req.param('groupId');
    const requestId = c.req.param('requestId');

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    let input: ResolveGroupRequestInput;
    try {
      input = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    try {
      const result = await groupsService.resolveJoinRequest(appPubkey, auth, groupId, requestId, input);
      return c.json(result);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  // Create group in app namespace
  app.post('/apps/:appNpub/groups', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    let appPubkey: string;
    try {
      appPubkey = resolveAppPubkey(appNpub).pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    let input: CreateGroupInput;
    try {
      input = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    try {
      const group = await groupsService.createGroup(appPubkey, auth, input);
      return c.json({ group }, 201);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.get('/apps/:appNpub/groups', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    let appPubkey: string;
    try {
      appPubkey = resolveAppPubkey(appNpub).pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    try {
      const groups = await groupsService.listMyGroups(appPubkey, auth);
      return c.json({ groups });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/apps/:appNpub/groups/:groupId/members', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');
    const groupId = c.req.param('groupId');

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    let appPubkey: string;
    try {
      appPubkey = resolveAppPubkey(appNpub).pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    try {
      const members = await groupsService.listGroupMembers(appPubkey, auth, groupId);
      return c.json({ members });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.post('/apps/:appNpub/groups/:groupId/members', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');
    const groupId = c.req.param('groupId');

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    let appPubkey: string;
    try {
      appPubkey = resolveAppPubkey(appNpub).pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    let input: AddGroupMemberInput;
    try {
      input = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    try {
      const result = await groupsService.addMember(appPubkey, auth, groupId, input);
      return c.json(result, result.created ? 201 : 200);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.delete('/apps/:appNpub/groups/:groupId/members/:memberNpub', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');
    const groupId = c.req.param('groupId');
    const memberNpub = c.req.param('memberNpub');

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    let appPubkey: string;
    try {
      appPubkey = resolveAppPubkey(appNpub).pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    try {
      const removed = await groupsService.removeMember(appPubkey, auth, groupId, memberNpub);
      if (!removed) return c.json({ error: 'Member not found or cannot be removed' }, 404);
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.post('/apps/:appNpub/groups/:groupId/requests', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');
    const groupId = c.req.param('groupId');

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    let appPubkey: string;
    try {
      appPubkey = resolveAppPubkey(appNpub).pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    let input: CreateGroupRequestInput;
    try {
      input = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    try {
      const result = await groupsService.createJoinRequest(appPubkey, auth, groupId, input);
      return c.json(result, result.created ? 201 : 200);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.get('/apps/:appNpub/groups/:groupId/requests', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');
    const groupId = c.req.param('groupId');
    const { status } = c.req.query();

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    let appPubkey: string;
    try {
      appPubkey = resolveAppPubkey(appNpub).pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    try {
      const requests = await groupsService.listJoinRequests(appPubkey, auth, groupId, status);
      return c.json({ requests });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.patch('/apps/:appNpub/groups/:groupId/requests/:requestId', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appNpub = c.req.param('appNpub');
    const groupId = c.req.param('groupId');
    const requestId = c.req.param('requestId');

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    let appPubkey: string;
    try {
      appPubkey = resolveAppPubkey(appNpub).pubkey;
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    let input: ResolveGroupRequestInput;
    try {
      input = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    try {
      const result = await groupsService.resolveJoinRequest(appPubkey, auth, groupId, requestId, input);
      return c.json(result);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  // ==================== Record Sync Routes (v3) ====================

  // Push config in default namespace (app-less mode)
  app.get('/push/config', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const config = getConfig();
    const appPubkey = resolveDefaultNamespacePubkey();

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);
    if (!appPubkey) return c.json({ error: 'Invalid app namespace' }, 400);

    return c.json({
      enabled: pushService.enabled(),
      vapid_public_key: config.pushVapidPublicKey || null,
      collections: ['chat_messages'],
    });
  });

  app.post('/push/subscribe', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();

    if (!pushService.enabled()) return c.json({ error: 'Push notifications are disabled on this server' }, 503);

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

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

  app.post('/push/unsubscribe', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    let input: PushSubscriptionDeleteInput;
    try {
      input = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!input.endpoint) return c.json({ error: 'endpoint required' }, 400);

    const removed = await pushService.deleteSubscription(appPubkey, auth.pubkey, input.endpoint);
    return c.json({ success: true, removed });
  });

  app.get('/push/subscriptions', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    const subscriptions = await pushService.listSubscriptions(appPubkey, auth.pubkey);
    return c.json({ subscriptions });
  });

  // Sync records (default namespace, app-less mode)
  app.post('/records/sync', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    let records: SyncRecordInputV3[];
    try {
      const body = await c.req.json();
      records = body.records;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (!Array.isArray(records)) return c.json({ error: 'records array required' }, 400);

    try {
      const result = await recordsService.syncRecords(appPubkey, auth, records);
      if (result.outcomes?.length > 0) await pushService.notifyOnSyncOutcomes(appPubkey, auth.pubkey, result.outcomes);
      return c.json({ synced: result.synced, created: result.created, updated: result.updated, rejected: result.rejected });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/records/fetch', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();
    const { collection, since } = c.req.query();

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    try {
      const result = await recordsService.fetchRecords(appPubkey, auth, collection, since);
      return c.json(result);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/records/delegated', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();
    const { collection, owner, limit: limitStr, cursor } = c.req.query();

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    try {
      const limit = limitStr ? Math.min(parseInt(limitStr, 10), 100) : undefined;
      const result = await recordsService.fetchDelegatedRecords(appPubkey, auth.pubkey, collection, owner, limit, cursor);
      return c.json(result);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/records/history/:recordId', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();
    const recordId = c.req.param('recordId');
    const { include_data } = c.req.query();

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);

    try {
      const result = await recordsService.getRecordHistory(appPubkey, recordId, include_data === 'true');
      if (!result) return c.json({ error: 'Record not found' }, 404);
      return c.json(result);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.delete('/records', authMiddleware, async (c) => {
    const auth = c.get('auth');
    const appPubkey = resolveDefaultNamespacePubkey();
    const { record_id } = c.req.query();

    const access = await usersService.checkUserAccess(auth.pubkey);
    if (!access.allowed) return c.json({ error: access.reason || 'Access denied' }, 403);
    if (!record_id) return c.json({ error: 'record_id query parameter required' }, 400);

    try {
      const result = await recordsService.deleteRecord(appPubkey, auth, record_id);
      if (!result) return c.json({ error: 'Record not found or already deleted' }, 404);
      return c.json(result);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

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
