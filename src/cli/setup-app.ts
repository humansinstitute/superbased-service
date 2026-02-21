#!/usr/bin/env bun
/**
 * Interactive CLI for setting up a SuperBased app
 *
 * Usage: bun run cli
 */

import * as readline from 'readline';
import { generateSecretKey, getPublicKey, nip19, finalizeEvent } from 'nostr-tools';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string, defaultValue?: string): Promise<string> {
  const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  return new Promise((resolve) => {
    rl.question(`${question} ${hint}: `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === '') resolve(defaultYes);
      else resolve(a === 'y' || a === 'yes');
    });
  });
}

function print(msg: string) {
  console.log(msg);
}

function printHeader(msg: string) {
  console.log('\n' + '═'.repeat(60));
  console.log(`  ${msg}`);
  console.log('═'.repeat(60));
}

function printSection(msg: string) {
  console.log('\n' + '─'.repeat(40));
  console.log(`  ${msg}`);
  console.log('─'.repeat(40));
}

async function main() {
  printHeader('SuperBased App Setup');
  print('\nThis wizard will help you register an app and generate a token.\n');

  // Step 1: Server URL
  const serverUrl = await ask('Server URL', 'http://localhost:3080');

  // Test server connection
  print('\nChecking server connection...');
  let serverNpub: string;
  try {
    const healthRes = await fetch(`${serverUrl}/health`);
    if (!healthRes.ok) throw new Error(`HTTP ${healthRes.status}`);
    const health = await healthRes.json();
    serverNpub = health.serverNpub;
    if (!serverNpub) throw new Error('Server did not return serverNpub');
    print(`  ✓ Connected to server`);
    print(`  ✓ Server npub: ${serverNpub}`);
  } catch (err) {
    print(`  ✗ Failed to connect: ${err}`);
    print('\nMake sure the superbased service server is running.');
    rl.close();
    process.exit(1);
  }

  // Step 2: App keypair
  printSection('App Identity');

  const hasKey = await confirm('Do you have an existing app nsec?', false);

  let appSecretKey: Uint8Array;
  let appPubkeyHex: string;
  let appNpub: string;
  let appNsec: string;

  if (hasKey) {
    const nsecInput = await ask('Paste your app nsec');
    try {
      const decoded = nip19.decode(nsecInput);
      if (decoded.type !== 'nsec') throw new Error('Not an nsec');
      appSecretKey = decoded.data as Uint8Array;
      appPubkeyHex = getPublicKey(appSecretKey);
      appNpub = nip19.npubEncode(appPubkeyHex);
      appNsec = nsecInput;
      print(`  ✓ App npub: ${appNpub}`);
    } catch (err) {
      print(`  ✗ Invalid nsec: ${err}`);
      rl.close();
      process.exit(1);
    }
  } else {
    print('\nGenerating new keypair...');
    appSecretKey = generateSecretKey();
    appPubkeyHex = getPublicKey(appSecretKey);
    appNpub = nip19.npubEncode(appPubkeyHex);
    appNsec = nip19.nsecEncode(appSecretKey);
    print(`  ✓ Generated new keypair`);
    print(`\n  App npub: ${appNpub}`);
    print(`  App nsec: ${appNsec}`);
    print('\n  ⚠️  SAVE THE NSEC SECURELY - you will need it to generate more tokens!');
  }

  // Step 3: App name
  printSection('App Registration');
  const appName = await ask('App name', 'todo-flux');

  // Create attestation
  print('\nCreating attestation...');
  const attestationEvent = finalizeEvent({
    kind: 30079,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', 'superbased-registration'],
      ['server', serverNpub],
      ['name', appName],
    ],
    content: '',
  }, appSecretKey);

  const attestationBase64 = btoa(JSON.stringify(attestationEvent));

  // Register app
  print('Registering app...');
  const registerUrl = `${serverUrl}/apps/register`;
  const registerBody = JSON.stringify({ name: appName, attestation: attestationBase64 });

  const registerAuth = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['u', registerUrl],
      ['method', 'POST'],
      ['payload', bytesToHex(sha256(new TextEncoder().encode(registerBody)))],
    ],
    content: '',
  }, appSecretKey);

  try {
    const response = await fetch(registerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Nostr ${btoa(JSON.stringify(registerAuth))}`,
      },
      body: registerBody,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || response.statusText);
    }

    const result = await response.json();
    print(`  ✓ App registered`);
    print(`  ✓ Schema: ${result.schema_name}`);
    if (!result.created) {
      print(`  ℹ️  App was already registered`);
    }
  } catch (err) {
    print(`  ✗ Registration failed: ${err}`);
    rl.close();
    process.exit(1);
  }

  // Step 4: Generate token
  printSection('Token Generation');

  const httpUrl = await ask('HTTP endpoint URL (for client connections)', serverUrl);
  const relayUrl = await ask('Relay URL (for CVM fallback, optional)', '');

  print('\nGenerating token...');
  const tokenUrl = `${serverUrl}/apps/${appNpub}/token`;
  const tokenBodyObj: { http?: string; relay?: string } = {};
  if (httpUrl) tokenBodyObj.http = httpUrl;
  if (relayUrl) tokenBodyObj.relay = relayUrl;
  const tokenBody = JSON.stringify(tokenBodyObj);

  const tokenAuth = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['u', tokenUrl],
      ['method', 'POST'],
      ['payload', bytesToHex(sha256(new TextEncoder().encode(tokenBody)))],
    ],
    content: '',
  }, appSecretKey);

  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Nostr ${btoa(JSON.stringify(tokenAuth))}`,
      },
      body: tokenBody,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || response.statusText);
    }

    const result = await response.json();

    printHeader('Setup Complete!');

    print('\nApp npub:');
    print(`  ${appNpub}`);

    if (!hasKey) {
      print('\nApp nsec (SAVE THIS):');
      print(`  ${appNsec}`);
    }

    print('\nToken (paste this in your app):');
    print('─'.repeat(60));
    print(result.token);
    print('─'.repeat(60));

    print('\nNext steps:');
    print('  1. Copy the token above');
    print('  2. Paste it in your app\'s SuperBased settings');
    print('  3. Your app can now sync encrypted records!');

  } catch (err) {
    print(`  ✗ Token generation failed: ${err}`);
    rl.close();
    process.exit(1);
  }

  rl.close();
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  rl.close();
  process.exit(1);
});
