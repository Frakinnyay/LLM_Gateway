import client from 'prom-client';
import type { BreakerState } from '../../providers/src/circuitBreaker';
import type { ProviderEvent } from '../../providers/src/manager';

/**
 * Prometheus metrics. LABEL POLICY: every label has a small, bounded value set (route templates, status codes,
 * configured provider names, fixed enums). Tenant IDs, API keys, request IDs, models-from-user-input and raw URLs
 * are NEVER labels: each distinct label value creates a new time series held in memory by both the gateway and
 * Prometheus, so unbounded values cause memory growth and expensive queries. Per-tenant/per-request detail lives in PostgreSQL.
 */
export function createMetrics(getBreakers: () => Array<{ name: string; state: BreakerState }>) {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  const reg = [registry];

  const requests = new client.Counter({ name: 'gateway_requests_total', help: 'HTTP requests handled', labelNames: ['route', 'status'], registers: reg });
  const duration = new client.Histogram({
    name: 'gateway_request_duration_seconds', help: 'HTTP request duration', labelNames: ['route'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60], registers: reg,
  });
  const cacheHits = new client.Counter({ name: 'gateway_cache_hits_total', help: 'Cache hits', labelNames: ['type'], registers: reg });
  const cacheMisses = new client.Counter({ name: 'gateway_cache_misses_total', help: 'Cache misses (both levels)', registers: reg });
  const providerRequests = new client.Counter({ name: 'gateway_provider_requests_total', help: 'Provider attempts by outcome', labelNames: ['provider', 'outcome'], registers: reg });
  const providerFailures = new client.Counter({ name: 'gateway_provider_failures_total', help: 'Failed provider attempts by kind', labelNames: ['provider', 'kind'], registers: reg });
  const fallbacks = new client.Counter({ name: 'gateway_fallback_total', help: 'Requests served by a fallback provider', labelNames: ['from', 'to'], registers: reg });
  const tokens = new client.Counter({ name: 'gateway_tokens_total', help: 'Tokens consumed at providers', labelNames: ['provider', 'direction'], registers: reg });
  const cost = new client.Counter({ name: 'gateway_estimated_cost_total', help: 'Estimated provider cost (USD, from pricing.json)', labelNames: ['provider'], registers: reg });
  const rateLimited = new client.Counter({ name: 'gateway_rate_limit_rejections_total', help: 'Requests rejected by the rate limiter', registers: reg });
  const budgetRejected = new client.Counter({ name: 'gateway_budget_rejections_total', help: 'Requests rejected by the token budget', registers: reg });
  const logDropped = new client.Counter({ name: 'gateway_request_log_dropped_total', help: 'Request-log entries dropped', registers: reg });
  const STATE_VALUE: Record<BreakerState, number> = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 };
  new client.Gauge({
    name: 'gateway_circuit_breaker_state', help: 'Circuit breaker state per provider (0=closed, 1=half_open, 2=open)', labelNames: ['provider'], registers: reg,
    collect() { for (const b of getBreakers()) this.set({ provider: b.name }, STATE_VALUE[b.state]); },
  });

  return {
    registry,
    recordRequest(route: string, status: number, seconds: number): void {
      requests.inc({ route, status: String(status) });
      duration.observe({ route }, seconds);
    },
    recordCache(kind: 'HIT_EXACT' | 'HIT_SEMANTIC' | 'MISS'): void {
      if (kind === 'MISS') cacheMisses.inc(); else cacheHits.inc({ type: kind === 'HIT_EXACT' ? 'exact' : 'semantic' });
    },
    recordSpend(provider: string, inputTokens: number, outputTokens: number, costUsd: number | null): void {
      tokens.inc({ provider, direction: 'input' }, inputTokens);
      tokens.inc({ provider, direction: 'output' }, outputTokens);
      if (costUsd !== null) cost.inc({ provider }, costUsd);
    },
    recordRejection(code: string): void {
      if (code === 'RATE_LIMIT_EXCEEDED') rateLimited.inc();
      else if (code === 'TOKEN_BUDGET_EXCEEDED') budgetRejected.inc();
    },
    recordLogDrop(n: number): void { logDropped.inc(n); },
    handleProviderEvent(e: ProviderEvent): void {
      if (e.type === 'attempt') {
        providerRequests.inc({ provider: e.provider, outcome: e.outcome });
        if (e.outcome !== 'success' && e.outcome !== 'circuit_open') providerFailures.inc({ provider: e.provider, kind: e.outcome });
      } else if (e.type === 'fallback') {
        fallbacks.inc({ from: e.from, to: e.to });
      }
    },
  };
}
export type Metrics = ReturnType<typeof createMetrics>;
