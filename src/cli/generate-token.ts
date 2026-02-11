#!/usr/bin/env bun
/**
 * CLI tool to generate an access token for a registered app
 *
 * Usage:
 *   bun run src/cli/generate-token.ts --app npub1... --nsec nsec1... --server https://...
 *
 * The app nsec is used to authenticate as the app owner via NIP-98.
 * Only the app owner can generate tokens for their app.
 */

import { parseArgs } from 'util';
import { nip19, finalizeEvent, getPublicKey } from 'nostr-tools';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

async function main() {
  const { values } = parseArgs({
    options: {
      app: { type: 'string', short: 'a' },
      nsec: { type: 'string', short: 's' },
      server: { type: 'string', default: 'http://localhost:3080' },
      relay: { type: 'string', short: 'r' },
      http: { type: 'string', short: 'h' },
    },
  });

  if (!values.app || !values.nsec) {
    console.error('Usage: --app <app-npub> --nsec <app-nsec> [--server <url>] [--relay wss://...] [--http https://...]');
    console.error('\nExample:');
    console.error('  bun run src/cli/generate-token.ts --app npub1abc... --nsec nsec1...');
    console.error('  bun run src/cli/generate-token.ts --app npub1abc... --nsec nsec1... --http https://api.example.com');
    process.exit(1);
  }

  // Decode app private key (need to sign the request as app owner)
  let appSecretKey: Uint8Array;
  try {
    const decoded = nip19.decode(values.nsec);
    if (decoded.type !== 'nsec') throw new Error('Invalid nsec');
    appSecretKey = decoded.data as Uint8Array;
  } catch (err) {
    console.error('Invalid nsec format:', err);
    process.exit(1);
  }

  const appPubkeyHex = getPublicKey(appSecretKey);
  const appNpubFromKey = nip19.npubEncode(appPubkeyHex);

  // Verify the nsec matches the app npub
  if (appNpubFromKey !== values.app) {
    console.error('Error: The provided nsec does not match the app npub');
    console.error(`  nsec resolves to: ${appNpubFromKey}`);
    console.error(`  but --app is: ${values.app}`);
    process.exit(1);
  }

  console.log('Generating token...');
  console.log(`  App: ${values.app}`);
  console.log(`  Server: ${values.server}`);
  if (values.relay) console.log(`  Relay: ${values.relay}`);
  if (values.http) console.log(`  HTTP: ${values.http}`);

  // Build request
  const url = `${values.server}/apps/${values.app}/token`;
  const bodyObj: { relay?: string; http?: string } = {};
  if (values.relay) bodyObj.relay = values.relay;
  if (values.http) bodyObj.http = values.http;
  const body = JSON.stringify(bodyObj);

  // Create NIP-98 auth
  const nip98Event = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['u', url],
      ['method', 'POST'],
      ['payload', bytesToHex(sha256(new TextEncoder().encode(body)))],
    ],
    content: '',
  }, appSecretKey);

  const authHeader = `Nostr ${btoa(JSON.stringify(nip98Event))}`;

  // Call the token endpoint
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      body,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      console.error('Token generation failed:', error);
      process.exit(1);
    }

    const result = await response.json();
    console.log('\nToken generated successfully!\n');
    console.log('Token:');
    console.log('─'.repeat(60));
    console.log(result.token);
    console.log('─'.repeat(60));
    console.log('\nPaste this token in your app to connect to SuperBased.');
  } catch (err) {
    console.error('Failed to generate token:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
