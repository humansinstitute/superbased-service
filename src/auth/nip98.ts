import { verifyEvent, nip19 } from 'nostr-tools';
import type { Event } from 'nostr-tools';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { getConfig } from '../config';
import type { Nip98Result, AuthContext } from '../types';

// NIP-98 kind for HTTP Auth
const NIP98_KIND = 27235;

/**
 * Extract and decode the NIP-98 event from Authorization header
 */
function extractNip98Event(authHeader: string): Event | null {
  if (!authHeader.startsWith('Nostr ')) {
    return null;
  }

  const base64Event = authHeader.slice(6); // Remove 'Nostr ' prefix

  try {
    const jsonStr = atob(base64Event);
    const event = JSON.parse(jsonStr) as Event;
    return event;
  } catch {
    return null;
  }
}

/**
 * Get tag value from event
 */
function getTagValue(event: Event, tagName: string): string | undefined {
  const tag = event.tags.find(t => t[0] === tagName);
  return tag?.[1];
}

/**
 * Verify a NIP-98 authentication event
 */
export function verifyNip98(
  authHeader: string,
  requestUrl: string,
  requestMethod: string,
  requestBody?: string
): Nip98Result {
  const config = getConfig();

  // Extract event from header
  const event = extractNip98Event(authHeader);
  if (!event) {
    return { valid: false, error: 'Invalid Authorization header format' };
  }

  // Check kind
  if (event.kind !== NIP98_KIND) {
    return { valid: false, error: `Invalid event kind: ${event.kind}, expected ${NIP98_KIND}` };
  }

  // Verify signature
  if (!verifyEvent(event)) {
    return { valid: false, error: 'Invalid event signature' };
  }

  // Check timestamp (not too old)
  const now = Math.floor(Date.now() / 1000);
  const age = now - event.created_at;
  if (age > config.nip98MaxAgeSeconds) {
    return { valid: false, error: `Event too old: ${age}s (max: ${config.nip98MaxAgeSeconds}s)` };
  }

  // Check timestamp (not in future)
  if (event.created_at > now + 60) {
    return { valid: false, error: 'Event timestamp is in the future' };
  }

  // Verify URL tag
  const urlTag = getTagValue(event, 'u');
  if (!urlTag) {
    return { valid: false, error: 'Missing URL tag' };
  }

  // Normalize URLs for comparison
  const normalizedRequestUrl = normalizeUrl(requestUrl);
  const normalizedTagUrl = normalizeUrl(urlTag);

  if (normalizedRequestUrl !== normalizedTagUrl) {
    return {
      valid: false,
      error: `URL mismatch: request=${normalizedRequestUrl}, tag=${normalizedTagUrl}`
    };
  }

  // Verify method tag
  const methodTag = getTagValue(event, 'method');
  if (!methodTag) {
    return { valid: false, error: 'Missing method tag' };
  }

  if (methodTag.toUpperCase() !== requestMethod.toUpperCase()) {
    return {
      valid: false,
      error: `Method mismatch: request=${requestMethod}, tag=${methodTag}`
    };
  }

  // Verify payload hash if present (optional but recommended for POST/PUT/PATCH)
  const payloadTag = getTagValue(event, 'payload');
  if (payloadTag && requestBody) {
    const bodyHash = bytesToHex(sha256(new TextEncoder().encode(requestBody)));
    if (payloadTag !== bodyHash) {
      return { valid: false, error: 'Payload hash mismatch' };
    }
  }

  return { valid: true, pubkey: event.pubkey };
}

/**
 * Normalize URL for comparison (remove trailing slashes, lowercase host)
 * Also normalizes http/https to handle reverse proxy scenarios
 */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Lowercase the host
    parsed.hostname = parsed.hostname.toLowerCase();
    // Normalize protocol to https (handles reverse proxy http->https mismatch)
    parsed.protocol = 'https:';
    // Remove default ports
    if (parsed.port === '443' || parsed.port === '80') {
      parsed.port = '';
    }
    // Remove trailing slash from pathname
    if (parsed.pathname.endsWith('/') && parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Create auth context from verified NIP-98 result
 */
export function createAuthContext(pubkey: string): AuthContext {
  const config = getConfig();
  const npub = nip19.npubEncode(pubkey);

  // Check if admin
  const isAdmin = config.adminNpubs.some(
    admin => admin === npub || admin === pubkey
  );

  return {
    pubkey,
    npub,
    isAdmin,
  };
}

/**
 * Create a NIP-98 event for signing (client-side helper)
 */
export function createNip98EventTemplate(
  url: string,
  method: string,
  body?: string
): Omit<Event, 'id' | 'sig' | 'pubkey'> {
  const tags: string[][] = [
    ['u', url],
    ['method', method.toUpperCase()],
  ];

  if (body) {
    const bodyHash = bytesToHex(sha256(new TextEncoder().encode(body)));
    tags.push(['payload', bodyHash]);
  }

  return {
    kind: NIP98_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
}
