import type Redis from 'ioredis';
import { KEY_NS } from '../../shared/src/constants';

/**
 * Atomic token bucket. Runs as ONE Lua script, so Redis executes refill + check + consume
 * without interleaving other clients. A client-side GET / compute / SET sequence is a
 * read-modify-write race: two concurrent requests both read "1 token left", both
 * consume it, and the limit is exceeded.
 *
 * Time comes from Redis (TIME), not the app server, so multiple gateway instances with
 * skewed clocks cannot corrupt refill math.
 *
 * Returns { allowed (1|0), floor(tokens remaining), retry_after_ms }.
 */
const LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local d = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(d[1])
local ts = tonumber(d[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end

local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + (elapsed / 1000) * rate)

local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil(((cost - tokens) / rate) * 1000)
end

redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', tostring(now))
-- Idle buckets expire after twice the time needed to refill fully (bounded memory).
redis.call('PEXPIRE', key, math.ceil((capacity / rate) * 1000) * 2)
return { allowed, math.floor(tokens), retry }
`;

type BucketRedis = Redis & {
  llmgwTokenBucket(key: string, capacity: number, rate: number, cost: number): Promise<[number, number, number]>;
};

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterMs: number;
}

export interface TokenBucketOptions {
  capacity: number;
  refillPerSec: number;
}

export class TokenBucketRateLimiter {
  private readonly redis: BucketRedis;

  constructor(redis: Redis, private readonly opts: TokenBucketOptions) {
    redis.defineCommand('llmgwTokenBucket', { numberOfKeys: 1, lua: LUA });
    this.redis = redis as BucketRedis;
  }

  /** Throws if Redis is unreachable; the caller decides fail-open vs fail-closed. */
  async consume(tenantId: string, cost = 1): Promise<RateLimitResult> {
    const key = `${KEY_NS}:rl:tenant:${tenantId}`;
    const [allowed, remaining, retry] = await this.redis.llmgwTokenBucket(
      key, this.opts.capacity, this.opts.refillPerSec, cost,
    );
    return { allowed: allowed === 1, limit: this.opts.capacity, remaining, retryAfterMs: retry };
  }
}
