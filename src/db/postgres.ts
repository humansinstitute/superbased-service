import postgres from 'postgres';
import { getConfig } from '../config';

/** Row shape matching superbased_records_v3 */
export interface RecordRow {
  id: string;
  app_pubkey: string;
  record_id: string;
  user_pubkey: string;
  version: number;
  record_state: 'live' | 'superseded' | 'deleted';
  collection: string;
  encrypted_data: string;
  encrypted_from: string;
  delegate_payloads: Record<string, string> | null;
  created_at: string;
}

let sql: postgres.Sql | null = null;

/** Get or create the Postgres connection pool */
export function getDb(): postgres.Sql {
  if (!sql) {
    const config = getConfig();
    sql = postgres(config.postgresUrl, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      types: {
        // Return timestamps as raw strings instead of Date objects
        // to prevent RangeError on invalid/out-of-range dates in the DB
        date: {
          to: 1184,
          from: [1082, 1083, 1114, 1184],
          serialize: (x: string | Date) => (x instanceof Date ? x.toISOString() : x),
          parse: (x: string) => x,
        },
      },
    });
  }
  return sql;
}

/** Close the connection pool (for CLI scripts) */
export async function closeDb(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = null;
  }
}
