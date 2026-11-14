import type { RequestHandler } from 'express';
import type { Deps } from '../types';

/** Maps a raw path to a BOUNDED route label (never the raw URL: it can contain ids and arbitrary client input). */
export function routeLabel(path: string): string {
  const p = path.split('?')[0] ?? '';
  if (p === '/v1/chat/completions') return 'chat_completions';
  if (p === '/v1/models') return 'models';
  if (p === '/health' || p === '/ready' || p === '/metrics') return p.slice(1);
  if (/^\/api\/tenants\/?$/.test(p)) return 'api_tenants';
  if (/^\/api\/keys(\/[^/]+)?\/?$/.test(p)) return 'api_keys';
  if (/^\/api\/providers/.test(p)) return 'api_providers';
  const m = /^\/api\/(usage|requests|cache|costs)/.exec(p);
  if (m) return `api_${m[1]}`;
  return 'other';
}

/**
 * Per-request observer: when the response closes (finished OR aborted) it records metrics, an access-log line, and
 * enqueues the async request-log row. Request IDs appear in the access log; prompt/response content never does.
 */
export function observe(deps: Deps): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.locals.obs = {};
    let done = false;
    res.on('close', () => {
      if (done) return;
      done = true;
      const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
      const aborted = !res.writableFinished;
      const status = aborted ? 499 : res.statusCode;
      const route = routeLabel(req.originalUrl);
      const obs = res.locals.obs;
      const code = res.locals.errorCode;
      const auth = res.locals.auth;

      deps.metrics.recordRequest(route, status, latencyMs / 1000);
      if (code) deps.metrics.recordRejection(code);

      if (route === 'chat_completions') {
        if (obs.cache === 'HIT_EXACT' || obs.cache === 'HIT_SEMANTIC' || obs.cache === 'MISS') deps.metrics.recordCache(obs.cache);
        if (obs.provider && obs.usage) deps.metrics.recordSpend(obs.provider, obs.usage.promptTokens, obs.usage.completionTokens, obs.costUsd ?? null);
        // Only authenticated requests are persisted: anonymous/invalid-key traffic is visible in metrics and logs but cannot flood the database.
        if (auth) {
          deps.requestLogger.enqueue({
            requestId: res.locals.requestId,
            tenantId: auth.tenantId,
            apiKeyId: auth.apiKeyId,
            provider: obs.provider ?? null,
            model: obs.model ?? null,
            inputTokens: obs.usage?.promptTokens ?? null,
            outputTokens: obs.usage?.completionTokens ?? null,
            totalTokens: obs.usage?.totalTokens ?? null,
            tokensEstimated: obs.usage?.estimated ?? false,
            latencyMs: Math.round(latencyMs),
            statusCode: status,
            // BYPASS = cache not consulted (client opt-out, or rejected before the cache lookup)
            cacheStatus: obs.cache ?? 'BYPASS',
            streamed: obs.streamed ?? false,
            estimatedCostUsd: obs.costUsd ?? null,
            estimatedSavingsUsd: obs.savingsUsd ?? null,
            fallbackUsed: obs.fallbackUsed ?? false,
            errorType: code ?? null,
            createdAt: new Date(),
          });
        }
      }
      const level = route === 'health' || route === 'metrics' || route === 'ready' ? 'debug' : 'info';
      deps.log[level]({
        requestId: res.locals.requestId, method: req.method, route, status, latencyMs: Math.round(latencyMs),
        tenantId: auth?.tenantId, provider: obs.provider, cache: obs.cache, errorCode: code,
      }, 'request');
    });
    next();
  };
}
