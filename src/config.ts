import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

export interface Config {
  // Fluxbase
  fluxbaseUrl: string;
  fluxbaseAnonKey: string;
  fluxbaseServiceKey: string;

  // HTTP Server
  httpPort: number;
  httpHost: string;

  // Nostr/CVM
  nostrRelays: string[];
  serverPrivateKey: Uint8Array;
  serverPublicKey: string;

  // Security
  adminNpubs: string[];
  nip98MaxAgeSeconds: number;

  // Logging
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvOptional(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

export function loadConfig(): Config {
  // Generate or load server key
  let serverPrivateKey: Uint8Array;
  const privateKeyHex = process.env.SERVER_PRIVATE_KEY;

  if (privateKeyHex && privateKeyHex.length === 64) {
    serverPrivateKey = hexToBytes(privateKeyHex);
  } else {
    console.log('No SERVER_PRIVATE_KEY provided, generating new keypair...');
    serverPrivateKey = generateSecretKey();
    console.log(`Generated SERVER_PRIVATE_KEY=${bytesToHex(serverPrivateKey)}`);
    console.log('Add this to your .env file to persist the server identity');
  }

  const serverPublicKey = getPublicKey(serverPrivateKey);

  // Parse relay list
  const relayStr = getEnvOptional('NOSTR_RELAYS', 'wss://relay.damus.io,wss://nos.lol');
  const nostrRelays = relayStr.split(',').map(r => r.trim()).filter(Boolean);

  // Parse admin npubs
  const adminStr = getEnvOptional('ADMIN_NPUBS', '');
  const adminNpubs = adminStr.split(',').map(n => n.trim()).filter(Boolean);

  return {
    // Fluxbase
    fluxbaseUrl: getEnv('FLUXBASE_URL', 'http://localhost:8090'),
    fluxbaseAnonKey: getEnvOptional('FLUXBASE_ANON_KEY', ''),
    fluxbaseServiceKey: getEnvOptional('FLUXBASE_SERVICE_KEY', ''),

    // HTTP Server
    httpPort: parseInt(getEnvOptional('HTTP_PORT', '3080'), 10),
    httpHost: getEnvOptional('HTTP_HOST', '0.0.0.0'),

    // Nostr/CVM
    nostrRelays,
    serverPrivateKey,
    serverPublicKey,

    // Security
    adminNpubs,
    nip98MaxAgeSeconds: parseInt(getEnvOptional('NIP98_MAX_AGE_SECONDS', '60'), 10),

    // Logging
    logLevel: getEnvOptional('LOG_LEVEL', 'info') as Config['logLevel'],
  };
}

// Singleton config instance
let configInstance: Config | null = null;

export function getConfig(): Config {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}
