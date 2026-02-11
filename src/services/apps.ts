import { FluxbaseClient } from '../fluxbase/client';
import { getConfig } from '../config';
import { nip19, verifyEvent, finalizeEvent } from 'nostr-tools';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { AuthContext, AppInfo, RegisterResult, TokenGenerationOptions } from '../types';

/**
 * Service for managing app registration and tokens
 */
export class AppsService {
  /**
   * Register a new app
   * - Verifies attestation is signed by app owner
   * - Verifies attestation points to this server
   * - Creates app record and schema
   */
  async registerApp(
    auth: AuthContext,
    name: string,
    attestationBase64: string
  ): Promise<RegisterResult> {
    const config = getConfig();

    // Decode and verify attestation
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

    // Verify attestation points to this server
    const serverNpub = nip19.npubEncode(config.serverPublicKey);
    const attestedServer = attestation.tags.find((t: string[]) => t[0] === 'server')?.[1];
    if (attestedServer !== serverNpub) {
      throw new Error(`Attestation is for a different server. Expected ${serverNpub}, got ${attestedServer}`);
    }

    // App pubkey is the attestation signer
    const appPubkeyHex = attestation.pubkey;
    const appNpub = nip19.npubEncode(appPubkeyHex);

    // The authenticated user must be the app (signing with app nsec)
    if (auth.pubkey !== appPubkeyHex) {
      throw new Error('Must authenticate as app owner to register');
    }

    // Generate schema name from app pubkey
    const schemaHash = bytesToHex(sha256(appPubkeyHex)).slice(0, 16);
    const schemaName = `app_${schemaHash}`;

    // Check if already registered
    const existing = await this.getApp(appPubkeyHex);
    if (existing) {
      return { app_npub: appNpub, schema_name: existing.schema_name, created: false };
    }

    // Use service key for admin operations
    const client = new FluxbaseClient(config.fluxbaseServiceKey);

    // Create app record
    const result = await client.insert({
      table: 'superbased_apps',
      data: {
        app_pubkey: appPubkeyHex,
        owner_pubkey: appPubkeyHex,
        name,
        schema_name: schemaName,
        attestation_event: JSON.stringify(attestation),
      },
    });

    if (result.error) {
      throw new Error(`Failed to register app: ${result.error}`);
    }

    // No per-app schema needed - we use a shared superbased_records table
    // with app_pubkey column to isolate data

    return { app_npub: appNpub, schema_name: schemaName, created: true };
  }

  /**
   * Generate token for app (only owner can generate)
   */
  async generateToken(
    auth: AuthContext,
    appNpub: string,
    options: TokenGenerationOptions = {}
  ): Promise<string> {
    const config = getConfig();
    const appInfo = await this.getAppByNpub(appNpub);

    if (!appInfo) {
      throw new Error('App not found');
    }

    // Must be app owner
    if (auth.pubkey !== appInfo.app_pubkey) {
      throw new Error('Only app owner can generate tokens');
    }

    const serverNpub = nip19.npubEncode(config.serverPublicKey);

    // Build token tags
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

    // Server signs the token
    const tokenEvent = finalizeEvent({
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '',
    }, config.serverPrivateKey);

    return btoa(JSON.stringify(tokenEvent));
  }

  /**
   * Get app by pubkey (hex)
   */
  async getApp(appPubkeyHex: string): Promise<AppInfo | null> {
    const config = getConfig();
    const client = new FluxbaseClient(config.fluxbaseServiceKey);

    const result = await client.query({
      table: 'superbased_apps',
      filter: { app_pubkey: appPubkeyHex },
      limit: 1,
    });

    if (result.error || !result.data?.length) {
      return null;
    }

    return result.data[0] as AppInfo;
  }

  /**
   * Get app by npub
   */
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

  /**
   * List apps owned by pubkey
   */
  async listApps(ownerPubkeyHex: string): Promise<AppInfo[]> {
    const config = getConfig();
    const client = new FluxbaseClient(config.fluxbaseServiceKey);

    const result = await client.query({
      table: 'superbased_apps',
      filter: { owner_pubkey: ownerPubkeyHex },
    });

    return (result.data || []) as AppInfo[];
  }
}

// Singleton instance
export const appsService = new AppsService();
