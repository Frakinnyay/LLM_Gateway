import { resolve } from 'node:path';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { ApiKeyRepository } from '../../../packages/auth/src/repository';
import { createEmbeddingProvider } from '../../../packages/cache/src/embedding';
import { ExactCache } from '../../../packages/cache/src/exactCache';
import { SemanticCache } from '../../../packages/cache/src/semanticCache';
import type { Config } from '../../../packages/config/src';
import { RequestLogger } from '../../../packages/database/src/requestLogger';
import { createMetrics } from '../../../packages/metrics/src';
import { ProviderManager } from '../../../packages/providers/src/manager';
import { buildProviders } from '../../../packages/providers/src/registry';
import { TokenBucketRateLimiter } from '../../../packages/rate-limit/src/tokenBucket';
import { TokenBudget } from '../../../packages/rate-limit/src/tokenBudget';
import { loadPricing } from '../../../packages/shared/src/pricing';
import type { Logger } from '../../../packages/shared/src/logger';
import type { Deps } from './types';

/**
 * Single place that wires configuration + connections into the dependency graph. Used by the server entrypoint AND by
 * integration tests, so tests exercise the same wiring as production. Does not start timers or listen on a port.
 */
export async function buildDeps(cfg: Config, pool: Pool, redis: Redis, log: Logger): Promise<Deps> {
  const metrics = createMetrics(() => providers.status().map((p) => ({ name: p.name, state: p.circuit.state })));
  const providers: ProviderManager = new ProviderManager(buildProviders(cfg), cfg.PROVIDER_PRIORITY, {
    timeoutMs: cfg.PROVIDER_TIMEOUT_MS,
    totalTimeoutMs: cfg.PROVIDER_TOTAL_TIMEOUT_MS,
    streamIdleTimeoutMs: cfg.STREAM_IDLE_TIMEOUT_MS,
    streamMaxDurationMs: cfg.STREAM_MAX_DURATION_MS,
    maxRetries: cfg.PROVIDER_MAX_RETRIES,
    retryBaseDelayMs: cfg.PROVIDER_RETRY_BASE_DELAY_MS,
    breaker: {
      failureThreshold: cfg.CB_FAILURE_THRESHOLD,
      cooldownMs: cfg.CB_COOLDOWN_MS,
      halfOpenMaxRequests: cfg.CB_HALF_OPEN_MAX_REQUESTS,
    },
    onEvent: (e) => { metrics.handleProviderEvent(e); log.info({ providerEvent: e }, 'provider event'); },
  });

  // Restore runtime enable/disable choices persisted by the admin API (table may not exist before `npm run migrate`).
  const disabled = await pool.query<{ provider: string }>('SELECT provider FROM provider_configs WHERE enabled = false')
    .catch(() => ({ rows: [] as Array<{ provider: string }> }));
  for (const row of disabled.rows) providers.setEnabled(row.provider, false);

  return {
    cfg, log, pool, redis, providers, metrics,
    apiKeys: new ApiKeyRepository(pool, cfg.API_KEY_PEPPER),
    rateLimiter: new TokenBucketRateLimiter(redis, { capacity: cfg.RATE_LIMIT_CAPACITY, refillPerSec: cfg.RATE_LIMIT_REFILL_PER_SEC }),
    tokenBudget: new TokenBudget(pool),
    exactCache: new ExactCache(redis, cfg.EXACT_CACHE_TTL_SECONDS, cfg.EXACT_CACHE_MAX_BYTES),
    embedder: createEmbeddingProvider(cfg.EMBEDDING_PROVIDER, cfg.EMBEDDING_DIMENSIONS),
    semanticCache: new SemanticCache(pool, cfg.SEMANTIC_CACHE_THRESHOLD, cfg.SEMANTIC_CACHE_TTL_SECONDS),
    pricing: loadPricing(resolve(process.cwd(), cfg.PRICING_FILE), (m) => log.warn(m)),
    requestLogger: new RequestLogger(pool, {
      maxQueue: cfg.REQUEST_LOG_QUEUE_MAX,
      batchSize: cfg.REQUEST_LOG_BATCH_SIZE,
      flushIntervalMs: cfg.REQUEST_LOG_FLUSH_INTERVAL_MS,
      log,
      onDrop: (n) => metrics.recordLogDrop(n),
    }),
  };
}
