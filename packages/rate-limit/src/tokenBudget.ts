import type { Pool } from 'pg';

export interface Reservation {
  tenantId: string;
  period: string; // YYYY-MM-01 (UTC)
  reserved: number;
}

export type ReserveResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; remaining: number };

/**
 * Monthly token budget enforced in PostgreSQL with reserve -> settle:
 *  1. reserve(): one atomic conditional UPDATE adds the *estimated* cost to reserved_tokens
 *     only if total + reserved + estimate <= budget. Postgres row locks serialise concurrent
 *     reservations for a tenant, and READ COMMITTED re-evaluates the WHERE after acquiring
 *     the lock, so concurrent requests cannot jointly exceed the budget on reservations.
 *  2. settle(): replaces the reservation with actual (or estimated, flagged) usage.
 *  3. release(): returns the reservation if the provider call failed.
 * Residual overshoot is bounded by (actual - estimate) when input size is underestimated.
 * A process crash between reserve and settle leaks that reservation (documented limitation).
 * Monthly reset: each UTC month has its own row, so a new month starts at zero automatically.
 */
export class TokenBudget {
  constructor(private readonly pool: Pool) {}

  static periodStart(now: Date = new Date()): string {
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }

  async reserve(tenantId: string, budget: number, amount: number, now = new Date()): Promise<ReserveResult> {
    const period = TokenBudget.periodStart(now);
    await this.pool.query(
      'INSERT INTO usage_records(tenant_id, period_start) VALUES ($1, $2::date) ON CONFLICT DO NOTHING',
      [tenantId, period],
    );
    const upd = await this.pool.query(
      `UPDATE usage_records
          SET reserved_tokens = reserved_tokens + $3, updated_at = now()
        WHERE tenant_id = $1 AND period_start = $2::date
          AND total_tokens + reserved_tokens + $3 <= $4`,
      [tenantId, period, amount, budget],
    );
    if ((upd.rowCount ?? 0) === 1) return { ok: true, reservation: { tenantId, period, reserved: amount } };
    const row = (await this.pool.query<{ used: string }>(
      'SELECT (total_tokens + reserved_tokens) AS used FROM usage_records WHERE tenant_id=$1 AND period_start=$2::date',
      [tenantId, period],
    )).rows[0];
    return { ok: false, remaining: Math.max(0, budget - Number(row?.used ?? 0)) };
  }

  async settle(r: Reservation, actual: { input: number; output: number }): Promise<void> {
    await this.pool.query(
      `UPDATE usage_records
          SET reserved_tokens = GREATEST(reserved_tokens - $3, 0),
              input_tokens  = input_tokens  + $4,
              output_tokens = output_tokens + $5,
              total_tokens  = total_tokens  + $4 + $5,
              updated_at = now()
        WHERE tenant_id = $1 AND period_start = $2::date`,
      [r.tenantId, r.period, r.reserved, actual.input, actual.output],
    );
  }

  async release(r: Reservation): Promise<void> {
    await this.pool.query(
      `UPDATE usage_records SET reserved_tokens = GREATEST(reserved_tokens - $3, 0), updated_at = now()
        WHERE tenant_id = $1 AND period_start = $2::date`,
      [r.tenantId, r.period, r.reserved],
    );
  }
}
