import type { Pool } from 'pg';
import type Redis from 'ioredis';
import type { Config } from '../../../packages/config/src';
import type { ApiKeyRepository, AuthContext } from '../../../packages/auth/src/repository';
import type { ProviderManager } from '../../../packages/providers/src/manager';
import type { ExactCache } from '../../../packages/cache/src/exactCache';
import type { EmbeddingProvider } from '../../../packages/cache/src/embedding';
import type { SemanticCache } from '../../../packages/cache/src/semanticCache';
import type { TokenBucketRateLimiter } from '../../../packages/rate-limit/src/tokenBucket';
import type { TokenBudget } from '../../../packages/rate-limit/src/tokenBudget';
import type { RequestLogger } from '../../../packages/database/src/requestLogger';
import type { Metrics } from '../../../packages/metrics/src';
import type { Usage } from '../../../packages/providers/src/types';
import type { PricingTable } from '../../../packages/shared/src/pricing';
import type { Logger } from '../../../packages/shared/src/logger';

export interface Deps {
  cfg: Config;
  log: Logger;
  pool: Pool;
  redis: Redis;
  apiKeys: ApiKeyRepository;
  providers: ProviderManager;
  rateLimiter: TokenBucketRateLimiter;
  tokenBudget: TokenBudget;
  exactCache: ExactCache;
  embedder: EmbeddingProvider;
  semanticCache: SemanticCache;
  pricing: PricingTable;
  metrics: Metrics;
  requestLogger: RequestLogger;
}

/** Filled in progressively by handlers; consumed once when the response closes (metrics + async request log). */
export interface RequestObservation {
  provider?: string;
  model?: string;
  cache?: 'HIT_EXACT' | 'HIT_SEMANTIC' | 'MISS' | 'BYPASS';
  streamed?: boolean;
  /** Tokens spent at a provider for THIS request (undefined for cache hits). */
  usage?: Usage | null;
  costUsd?: number | null;
  savingsUsd?: number | null;
  fallbackUsed?: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      requestId: string;
      auth?: AuthContext;
      obs: RequestObservation;
      errorCode?: string;
    }
  }
}
