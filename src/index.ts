/**
 * Flux Adaptor - Nostr-native gateway to Fluxbase
 *
 * Provides two access methods:
 * 1. Direct HTTP - Fast path with NIP-98 authentication
 * 2. Nostr/CVM - Private path via Nostr relays (no domain needed)
 *
 * Both methods authenticate users via their Nostr keys (NIP-98)
 * and map them to Fluxbase users automatically.
 */

import { getConfig } from './config';
import { startHttpServer } from './transports/http';
import { startCvmTransport } from './transports/cvm';
import { nip19 } from 'nostr-tools';

async function main() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║               FLUX ADAPTOR v0.1.0                         ║');
  console.log('║         Nostr-native gateway to Fluxbase                  ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');

  // Load configuration
  const config = getConfig();

  // Display server identity
  const npub = nip19.npubEncode(config.serverPublicKey);
  console.log('Server Identity:');
  console.log(`  npub: ${npub}`);
  console.log(`  hex:  ${config.serverPublicKey}`);
  console.log('');

  // Display Fluxbase connection
  console.log('Fluxbase:');
  console.log(`  URL: ${config.fluxbaseUrl}`);
  console.log(`  Service Key: ${config.fluxbaseServiceKey ? '****' + config.fluxbaseServiceKey.slice(-4) : 'not configured'}`);
  console.log('');

  // Start HTTP server
  console.log('Starting HTTP transport...');
  const httpServer = await startHttpServer();
  console.log(`  ✓ HTTP server running on http://${config.httpHost}:${config.httpPort}`);
  console.log('');

  // Start CVM transport
  console.log('Starting CVM transport...');
  await startCvmTransport();
  console.log(`  ✓ CVM listening on relays:`);
  for (const relay of config.nostrRelays) {
    console.log(`    - ${relay}`);
  }
  console.log('');

  // Display endpoints
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('HTTP Endpoints (NIP-98 auth required):');
  console.log('');
  console.log('  Auth:');
  console.log(`    GET  /auth/me              - Current user info`);
  console.log('');
  console.log('  Database:');
  console.log(`    GET  /db/:table            - Query records`);
  console.log(`    POST /db/:table            - Insert records`);
  console.log(`    PATCH /db/:table           - Update records`);
  console.log(`    DELETE /db/:table          - Delete records`);
  console.log('');
  console.log('  Storage:');
  console.log(`    POST /storage/:bucket/*    - Upload file`);
  console.log(`    GET  /storage/:bucket/*    - Download file`);
  console.log(`    GET  /storage/:bucket      - List files`);
  console.log(`    DELETE /storage/:bucket/*  - Delete file`);
  console.log('');
  console.log('  Functions:');
  console.log(`    POST /functions/:name      - Invoke edge function`);
  console.log('');
  console.log('  DER Delegate (pull):');
  console.log(`    GET  /records/:app/delegated - Fetch records delegated to caller`);
  console.log('');
  console.log('  Health:');
  console.log(`    GET  /health               - Service health (no auth)`);
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('MCP Tools (via CVM/Nostr):');
  console.log('');
  console.log('  auth_whoami, db_query, db_insert, db_update, db_delete,');
  console.log('  storage_upload, storage_download, storage_list, storage_delete,');
  console.log('  function_invoke, fetch_delegated_records, health');
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('Ready to accept connections!');
  console.log('');

  // Handle shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\nShutting down...');
    process.exit(0);
  });
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
