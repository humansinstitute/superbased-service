#!/usr/bin/env bun
/**
 * CLI tool to register a new app with the superbased service
 *
 * Usage:
 *   bun run src/cli/create-app.ts --name todo-flux --nsec nsec1... --server https://...
 *
 * The app nsec is used to:
 * 1. Sign the attestation event (proves app identity)
 * 2. Sign the NIP-98 HTTP auth header (authenticates the request)
 */

import { parseArgs } from 'util';
import { nip19, finalizeEvent, getPublicKey } from 'nostr-tools';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

async function main() {
  const { values } = parseArgs({
    options: {
      name: { type: 'string', short: 'n' },
      nsec: { type: 'string', short: 's' },
      server: { type: 'string', default: 'http://localhost:3080' },
    },
  });

  if (!values.name || !values.nsec) {
    console.error('Usage: --name <app-name> --nsec <app-nsec> [--server <url>]');
    console.error('\nExample:');
    console.error('  bun run src/cli/create-app.ts --name todo-flux --nsec nsec1...');
    process.exit(1);
  }

  // Decode app private key
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
  const appNpub = nip19.npubEncode(appPubkeyHex);

  console.log('Registering app...');
  console.log(`  Name: ${values.name}`);
  console.log(`  App npub: ${appNpub}`);
  console.log(`  Server: ${values.server}`);

  // Fetch server info to get server npub
  let serverNpub: string;
  try {
    const healthRes = await fetch(`${values.server}/health`);
    if (!healthRes.ok) {
      throw new Error(`Health check failed: ${healthRes.status}`);
    }
    const health = await healthRes.json();
    serverNpub = health.serverNpub;
    if (!serverNpub) {
      throw new Error('Server did not return serverNpub');
    }
    console.log(`  Server npub: ${serverNpub}`);
  } catch (err) {
    console.error('Failed to fetch server info:', err);
    process.exit(1);
  }

  // Create attestation event (app signs)
  const attestationEvent = finalizeEvent({
    kind: 30079,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', 'superbased-registration'],
      ['server', serverNpub],
      ['name', values.name],
    ],
    content: '',
  }, appSecretKey);

  const attestationBase64 = btoa(JSON.stringify(attestationEvent));

  // Create request body
  const url = `${values.server}/apps/register`;
  const body = JSON.stringify({ name: values.name, attestation: attestationBase64 });

  // Create NIP-98 auth for the request (signed by app)
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

  // Call the register endpoint
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
      console.error('Registration failed:', error);
      process.exit(1);
    }

    const result = await response.json();
    console.log('\nApp registered successfully!');
    console.log(`  App npub: ${appNpub}`);
    console.log(`  Schema: ${result.schema_name}`);
    console.log(`  Created: ${result.created ? 'Yes' : 'No (already existed)'}`);
    console.log('\nGenerate tokens with:');
    console.log(`  bun run src/cli/generate-token.ts --app ${appNpub} --nsec ${values.nsec} --server ${values.server}`);
  } catch (err) {
    console.error('Failed to register app:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
