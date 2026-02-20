/**
 * Test preload: forces all tests to use the fluxbase_test database.
 * Loaded automatically via bunfig.toml [test].preload
 *
 * This prevents tests from ever touching the production database.
 */

const prodUrl = process.env.POSTGRES_URL ?? 'postgres://postgres:postgres@localhost:5432/fluxbase';

// Replace the database name with fluxbase_test
const testUrl = prodUrl.replace(/\/[^/?]+(\?|$)/, '/fluxbase_test$1');

if (testUrl === prodUrl) {
  // Fallback: just append _test if regex didn't match
  process.env.POSTGRES_URL = prodUrl + '_test';
} else {
  process.env.POSTGRES_URL = testUrl;
}

console.log(`[test-preload] Using test database: ${process.env.POSTGRES_URL}`);
