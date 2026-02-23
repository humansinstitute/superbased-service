import { getDb } from '../db/postgres';

export interface UsageReportRow {
  captured_hour: string;
  user_pubkey: string;
  live_records: number;
  retained_rows: number;
  retained_bytes: string;
  encrypted_data_bytes: string;
  delegate_payload_bytes: string;
}

export class UsageReportService {
  private timer: ReturnType<typeof setInterval> | null = null;

  async recomputeCurrentHour(): Promise<void> {
    const sql = getDb();

    await sql`
      INSERT INTO superbased_retained_usage_hourly (
        captured_hour,
        user_pubkey,
        live_records,
        retained_rows,
        retained_bytes,
        encrypted_data_bytes,
        delegate_payload_bytes
      )
      SELECT
        date_trunc('hour', now()) AS captured_hour,
        r.user_pubkey,
        COUNT(*) FILTER (WHERE r.record_state = 'live')::integer AS live_records,
        COUNT(*)::integer AS retained_rows,
        SUM(pg_column_size(r))::bigint AS retained_bytes,
        SUM(octet_length(r.encrypted_data))::bigint AS encrypted_data_bytes,
        SUM(COALESCE(octet_length(r.delegate_payloads::text), 0))::bigint AS delegate_payload_bytes
      FROM superbased_records_v3 r
      GROUP BY r.user_pubkey
      ON CONFLICT (captured_hour, user_pubkey)
      DO UPDATE SET
        live_records = EXCLUDED.live_records,
        retained_rows = EXCLUDED.retained_rows,
        retained_bytes = EXCLUDED.retained_bytes,
        encrypted_data_bytes = EXCLUDED.encrypted_data_bytes,
        delegate_payload_bytes = EXCLUDED.delegate_payload_bytes
    `;
  }

  async getLatestReport(limit = 500): Promise<{ captured_hour: string | null; rows: UsageReportRow[] }> {
    const sql = getDb();
    try {
      const latest = await sql<{ captured_hour: string }[]>`
        SELECT MAX(captured_hour)::text AS captured_hour
        FROM superbased_retained_usage_hourly
      `;

      const capturedHour = latest[0]?.captured_hour ?? null;
      if (!capturedHour) {
        // Ensure we can still show data even before first scheduler run.
        await this.recomputeCurrentHour();
        const fallbackLatest = await sql<{ captured_hour: string }[]>`
          SELECT MAX(captured_hour)::text AS captured_hour
          FROM superbased_retained_usage_hourly
        `;
        const fallbackHour = fallbackLatest[0]?.captured_hour ?? null;
        if (!fallbackHour) {
          return { captured_hour: null, rows: [] };
        }
        const fallbackRows = await this.getRowsForHour(fallbackHour, limit);
        return { captured_hour: fallbackHour, rows: fallbackRows };
      }

      const rows = await this.getRowsForHour(capturedHour, limit);
      return { captured_hour: capturedHour, rows };
    } catch (err: any) {
      // Migration not applied yet: serve live report directly from v3 records.
      if (err?.code === '42P01') {
        const rows = await this.getLiveFallback(limit);
        return { captured_hour: new Date().toISOString(), rows };
      }
      throw err;
    }
  }

  private async getRowsForHour(capturedHour: string, limit: number): Promise<UsageReportRow[]> {
    const sql = getDb();
    return sql<UsageReportRow[]>`
      SELECT
        captured_hour::text,
        user_pubkey,
        live_records,
        retained_rows,
        retained_bytes::text,
        encrypted_data_bytes::text,
        delegate_payload_bytes::text
      FROM superbased_retained_usage_hourly
      WHERE captured_hour = ${capturedHour}
      ORDER BY retained_bytes DESC, retained_rows DESC, user_pubkey ASC
      LIMIT ${Math.max(1, Math.min(limit, 5000))}
    `;
  }

  startScheduler(): void {
    if (this.timer) return;

    this.recomputeCurrentHour().catch((err) => {
      console.error('usage-report initial snapshot failed:', err);
    });

    this.timer = setInterval(() => {
      this.recomputeCurrentHour().catch((err) => {
        console.error('usage-report hourly snapshot failed:', err);
      });
    }, 60 * 60 * 1000);
  }

  private async getLiveFallback(limit: number): Promise<UsageReportRow[]> {
    const sql = getDb();
    return sql<UsageReportRow[]>`
      SELECT
        date_trunc('hour', now())::text AS captured_hour,
        r.user_pubkey,
        COUNT(*) FILTER (WHERE r.record_state = 'live')::integer AS live_records,
        COUNT(*)::integer AS retained_rows,
        SUM(pg_column_size(r))::bigint::text AS retained_bytes,
        SUM(octet_length(r.encrypted_data))::bigint::text AS encrypted_data_bytes,
        SUM(COALESCE(octet_length(r.delegate_payloads::text), 0))::bigint::text AS delegate_payload_bytes
      FROM superbased_records_v3 r
      GROUP BY r.user_pubkey
      ORDER BY SUM(pg_column_size(r)) DESC, COUNT(*) DESC, r.user_pubkey ASC
      LIMIT ${Math.max(1, Math.min(limit, 5000))}
    `;
  }
}

export const usageReportService = new UsageReportService();
