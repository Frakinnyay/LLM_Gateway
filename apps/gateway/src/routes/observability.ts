import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/common';
import { parseOrThrow } from '../schemas';
import type { Deps } from '../types';

const uuid = z.string().uuid();
const usageQuery = z.object({ tenant_id: uuid });
const requestsQuery = z.object({
  tenant_id: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().regex(/^\d{1,18}$/).optional(), // cursor = request_logs.id
});
const windowQuery = z.object({
  tenant_id: uuid.optional(),
  hours: z.coerce.number().int().min(1).max(720).default(24),
});
const costsQuery = windowQuery.extend({ bucket: z.enum(['hour', 'day']).default('hour') });

/** Read-only admin endpoints backing the dashboard. Data comes from the ASYNC request log, so it lags real time by up to the flush interval. */
export function observabilityRouter(deps: Deps): Router {
  const r = Router();

  r.get('/usage', asyncHandler(async (req, res) => {
    const q = parseOrThrow(usageQuery, req.query);
    const t = await deps.pool.query<{ monthly_token_budget: string }>('SELECT monthly_token_budget FROM tenants WHERE id = $1', [q.tenant_id]);
    const history = await deps.pool.query(
      `SELECT to_char(period_start,'YYYY-MM-DD') AS period_start, input_tokens, output_tokens, total_tokens, reserved_tokens
         FROM usage_records WHERE tenant_id = $1 ORDER BY period_start DESC LIMIT 12`, [q.tenant_id]);
    const rows = history.rows.map((x) => ({
      period_start: x.period_start, input_tokens: Number(x.input_tokens), output_tokens: Number(x.output_tokens),
      total_tokens: Number(x.total_tokens), reserved_tokens: Number(x.reserved_tokens),
    }));
    res.json({
      tenant_id: q.tenant_id,
      monthly_token_budget: t.rows[0] ? Number(t.rows[0].monthly_token_budget) : null,
      history: rows,
      note: 'Token counts marked estimated in request logs are approximations when the provider reported no usage.',
    });
  }));

  r.get('/requests', asyncHandler(async (req, res) => {
    const q = parseOrThrow(requestsQuery, req.query);
    const r2 = await deps.pool.query(
      `SELECT id::text, request_id, tenant_id, api_key_id, provider, model, input_tokens, output_tokens, total_tokens,
              tokens_estimated, latency_ms, status_code, cache_status, streamed,
              estimated_cost_usd::float8 AS estimated_cost_usd, estimated_savings_usd::float8 AS estimated_savings_usd,
              fallback_used, error_type, created_at
         FROM request_logs
        WHERE ($1::uuid IS NULL OR tenant_id = $1) AND ($2::bigint IS NULL OR id < $2::bigint)
        ORDER BY id DESC LIMIT $3`,
      [q.tenant_id ?? null, q.before ?? null, q.limit]);
    const last = r2.rows[r2.rows.length - 1] as { id: string } | undefined;
    res.json({ data: r2.rows, next_cursor: r2.rows.length === q.limit && last ? last.id : null });
  }));

  r.get('/cache/stats', asyncHandler(async (req, res) => {
    const q = parseOrThrow(windowQuery, req.query);
    const s = await deps.pool.query(
      `SELECT count(*) FILTER (WHERE cache_status = 'HIT_EXACT')::int AS exact_hits,
              count(*) FILTER (WHERE cache_status = 'HIT_SEMANTIC')::int AS semantic_hits,
              count(*) FILTER (WHERE cache_status = 'MISS')::int AS misses,
              count(*) FILTER (WHERE cache_status = 'BYPASS')::int AS not_consulted,
              coalesce(sum(estimated_savings_usd), 0)::float8 AS estimated_savings_usd
         FROM request_logs
        WHERE created_at >= now() - make_interval(hours => $1) AND ($2::uuid IS NULL OR tenant_id = $2)`,
      [q.hours, q.tenant_id ?? null]);
    const row = s.rows[0] as { exact_hits: number; semantic_hits: number; misses: number; not_consulted: number; estimated_savings_usd: number };
    const hits = row.exact_hits + row.semantic_hits;
    const consulted = hits + row.misses;
    const sc = await deps.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM semantic_cache WHERE expires_at > now()');
    res.json({
      window_hours: q.hours, ...row,
      hit_rate: consulted === 0 ? null : hits / consulted, // null until there is data; never a placeholder number
      semantic_cache_entries: (sc.rows[0] as { n: number }).n,
    });
  }));

  r.get('/costs', asyncHandler(async (req, res) => {
    const q = parseOrThrow(costsQuery, req.query);
    const unit = q.bucket === 'day' ? 'day' : 'hour'; // whitelisted by zod; selected, never interpolated from input
    const c = await deps.pool.query(
      `SELECT date_trunc('${unit}', created_at) AS bucket, count(*)::int AS requests,
              coalesce(sum(estimated_cost_usd), 0)::float8 AS estimated_cost_usd,
              coalesce(sum(estimated_savings_usd), 0)::float8 AS estimated_savings_usd
         FROM request_logs
        WHERE created_at >= now() - make_interval(hours => $1) AND ($2::uuid IS NULL OR tenant_id = $2)
        GROUP BY 1 ORDER BY 1`,
      [q.hours, q.tenant_id ?? null]);
    res.json({ bucket: unit, currency: deps.pricing.currency, data: c.rows });
  }));

  return r;
}
