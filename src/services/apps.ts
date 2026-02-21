import { getDb } from '../db/postgres';
import { nip19, verifyEvent, finalizeEvent } from 'nostr-tools';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { getConfig } from '../config';
import type { AppInfo, RegisterResult, TokenGenerationOptions, ConnectionTokenOptions } from '../types';

/**
 * Service for managing app registration and tokens
 */
export class AppsService {
  async registerApp(auth: { pubkey: string }, name: string, attestationBase64: string): Promise<RegisterResult> {
    const config = getConfig();

    let attestation: any;
    try {
      attestation = JSON.parse(atob(attestationBase64));
    } catch {
      throw new Error('Invalid attestation: failed to decode');
    }

    if (!verifyEvent(attestation)) {
      throw new Error('Invalid attestation signature');
    }

    if (attestation.kind !== 30079) {
      throw new Error(`Invalid attestation kind: expected 30079, got ${attestation.kind}`);
    }

    const serverNpub = nip19.npubEncode(config.serverPublicKey);
    const attestedServer = attestation.tags.find((t: string[]) => t[0] === 'server')?.[1];
    if (attestedServer !== serverNpub) {
      throw new Error(`Attestation is for a different server. Expected ${serverNpub}, got ${attestedServer}`);
    }

    const appPubkeyHex = attestation.pubkey;
    const appNpub = nip19.npubEncode(appPubkeyHex);

    if (auth.pubkey !== appPubkeyHex) {
      throw new Error('Must authenticate as app owner to register');
    }

    const schemaHash = bytesToHex(sha256(appPubkeyHex)).slice(0, 16);
    const schemaName = `app_${schemaHash}`;

    const existing = await this.getApp(appPubkeyHex);
    if (existing) {
      return { app_npub: appNpub, schema_name: existing.schema_name, created: false };
    }

    const sql = getDb();
    const inserted = await sql`
      INSERT INTO superbased_apps
        (app_pubkey, owner_pubkey, name, schema_name, attestation_event)
      VALUES
        (${appPubkeyHex}, ${appPubkeyHex}, ${name}, ${schemaName}, ${JSON.stringify(attestation)})
      RETURNING *
    `;

    if (inserted.length === 0) {
      throw new Error('Failed to register app');
    }

    return { app_npub: appNpub, schema_name: schemaName, created: true };
  }

  async generateToken(auth: { pubkey: string }, appNpub: string, options: TokenGenerationOptions = {}): Promise<string> {
    const config = getConfig();
    const appInfo = await this.getAppByNpub(appNpub);

    if (!appInfo) {
      throw new Error('App not found');
    }

    if (auth.pubkey !== appInfo.app_pubkey) {
      throw new Error('Only app owner can generate tokens');
    }

    const serverNpub = nip19.npubEncode(config.serverPublicKey);

    const tags: string[][] = [
      ['d', 'superbased-token'],
      ['app', appNpub],
      ['server', serverNpub],
      ['relay', options.relay || config.nostrRelays[0]],
      ['attestation', btoa(appInfo.attestation_event)],
    ];

    if (options.http) {
      tags.push(['http', options.http]);
    }

    const tokenEvent = finalizeEvent({
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '',
    }, config.serverPrivateKey);

    return btoa(JSON.stringify(tokenEvent));
  }

  /**
   * Generate app-agnostic connection token.
   * Token format: base64(json payload). No signature, no auth semantics.
   */
  generateConnectionToken(options: ConnectionTokenOptions = {}): string {
    const config = getConfig();
    const serverNpub = nip19.npubEncode(config.serverPublicKey);
    const now = Math.floor(Date.now() / 1000);
    const ttlSeconds = Math.max(60, Math.min(options.ttl_seconds ?? 60 * 60 * 24 * 30, 60 * 60 * 24 * 365));

    const payload = {
      type: 'superbased_connection',
      version: 1,
      issued_at: now,
      expires_at: now + ttlSeconds,
      server_npub: serverNpub,
      http: options.http || `http://${config.httpHost}:${config.httpPort}`,
      relay: options.relay || config.nostrRelays[0] || null,
      scopes: options.scopes && options.scopes.length > 0 ? options.scopes : [],
      note: 'Connection metadata only. API requests still require NIP-98 per request.',
    };

    return btoa(JSON.stringify(payload));
  }

  async getApp(appPubkeyHex: string): Promise<AppInfo | null> {
    const sql = getDb();

    const rows = await sql`
      SELECT * FROM superbased_apps
      WHERE app_pubkey = ${appPubkeyHex}
      LIMIT 1
    `;

    if (rows.length === 0) {
      return null;
    }

    return rows[0] as unknown as AppInfo;
  }

  async getAppByNpub(appNpub: string): Promise<AppInfo | null> {
    let decoded;
    try {
      decoded = nip19.decode(appNpub);
    } catch {
      return null;
    }
    if (decoded.type !== 'npub') return null;
    return this.getApp(decoded.data as string);
  }

  async listApps(ownerPubkeyHex: string): Promise<AppInfo[]> {
    const sql = getDb();

    const rows = await sql`
      SELECT * FROM superbased_apps
      WHERE owner_pubkey = ${ownerPubkeyHex}
    `;

    return rows as unknown as AppInfo[];
  }
}

export const appsService = new AppsService();
