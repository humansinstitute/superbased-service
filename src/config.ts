import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { existsSync } from 'node:fs';

export interface Config {
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
  serviceToken: string | null;

  // Postgres
  postgresUrl: string;

  // Logging
  logLevel: 'debug' | 'info' | 'warn' | 'error';

  // Web Push
  pushEnabled: boolean;
  pushVapidPublicKey: string | null;
  pushVapidPrivateKey: string | null;
  pushVapidSubject: string | null;

  // Object Storage
  storageEnabled: boolean;
  storageS3Endpoint: string;
  storageS3PublicEndpoint: string;
  storageS3Region: string;
  storageS3AccessKey: string;
  storageS3SecretKey: string;
  storageS3Bucket: string;
  storageS3ForcePathStyle: boolean;
  storagePresignUploadTtlSeconds: number;
  storagePresignDownloadTtlSeconds: number;
  storageDefaultTtlSeconds: number;
  storageDeletedRetentionSeconds: number;
  storageMaxObjectBytes: number;
  storageMaxBytesPerNpub: number;
}

function getEnvOptional(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function runningInDocker(): boolean {
  return existsSync('/.dockerenv');
}

function normalizePostgresUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    // Developer ergonomics: `.env` often uses docker-internal host `postgres`.
    // When running CLI from host shell, route that hostname to localhost.
    if (!runningInDocker() && parsed.hostname === 'postgres') {
      const hostPort = (process.env.POSTGRES_HOST_PORT || '55432').trim();
      parsed.hostname = 'localhost';
      if (hostPort) parsed.port = hostPort;
      return parsed.toString();
    }
  } catch {
    // Return raw value if it's not a valid URL; postgres client will surface a clear error.
  }
  return rawUrl;
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
    serviceToken: process.env.SERVICE_TOKEN || null,

    // Postgres
    postgresUrl: normalizePostgresUrl(
      getEnvOptional('POSTGRES_URL', 'postgres://postgres:postgres@localhost:5432/fluxbase')
    ),

    // Logging
    logLevel: getEnvOptional('LOG_LEVEL', 'info') as Config['logLevel'],

    // Web Push
    pushEnabled: getEnvOptional('PUSH_ENABLED', 'false') === 'true',
    pushVapidPublicKey: process.env.PUSH_VAPID_PUBLIC_KEY || null,
    pushVapidPrivateKey: process.env.PUSH_VAPID_PRIVATE_KEY || null,
    pushVapidSubject: process.env.PUSH_VAPID_SUBJECT || null,

    // Object Storage
    storageEnabled: getEnvOptional('STORAGE_ENABLED', 'true') === 'true',
    storageS3Endpoint: getEnvOptional('STORAGE_S3_ENDPOINT', 'http://localhost:9000'),
    storageS3PublicEndpoint: getEnvOptional(
      'STORAGE_S3_ENDPOINT_PUBLIC',
      getEnvOptional('STORAGE_S3_ENDPOINT', 'http://localhost:9000')
    ),
    storageS3Region: getEnvOptional('STORAGE_S3_REGION', 'us-east-1'),
    storageS3AccessKey: getEnvOptional('STORAGE_S3_ACCESS_KEY', 'superbased'),
    storageS3SecretKey: getEnvOptional('STORAGE_S3_SECRET_KEY', 'superbased-secret'),
    storageS3Bucket: getEnvOptional('STORAGE_S3_BUCKET', 'superbased-storage'),
    storageS3ForcePathStyle: getEnvOptional('STORAGE_S3_FORCE_PATH_STYLE', 'true') === 'true',
    storagePresignUploadTtlSeconds: parseInt(getEnvOptional('STORAGE_PRESIGN_UPLOAD_TTL_SECONDS', '900'), 10),
    storagePresignDownloadTtlSeconds: parseInt(getEnvOptional('STORAGE_PRESIGN_DOWNLOAD_TTL_SECONDS', '900'), 10),
    storageDefaultTtlSeconds: parseInt(getEnvOptional('STORAGE_DEFAULT_TTL_SECONDS', '2592000'), 10),
    storageDeletedRetentionSeconds: parseInt(getEnvOptional('STORAGE_DELETED_RETENTION_SECONDS', '86400'), 10),
    storageMaxObjectBytes: parseInt(getEnvOptional('STORAGE_MAX_OBJECT_BYTES', '104857600'), 10),
    storageMaxBytesPerNpub: parseInt(getEnvOptional('STORAGE_MAX_BYTES_PER_NPUB', '1073741824'), 10),
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
