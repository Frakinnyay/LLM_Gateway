import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { KEY_NS } from '../../shared/src/constants';
import type { ChatRequest, Usage } from '../../providers/src/types';

export interface CachedEntry {
  response: Record<string, unknown>;
  model: string;
  provider: string;
  usage: Usage | null;
  createdAt: string;
}

/**
 * Deterministic key over EVERYTHING that can change the answer: tenant, model, full messages
 * (role+content, exact text), temperature, top_p, max_tokens, stop. Absent params hash as null
 * so "unset" never collides with an explicit value. The tenant is included so one tenant's
 * cached answers can never be served to (or probed by) another. The provider is NOT part of
 * the key: a cached answer is served regardless of which provider originally produced it.
 * Bump KEY_NS (v1 -> v2) to invalidate everything when the key shape changes.
 */
export function buildCacheKey(tenantId: string, req: ChatRequest): string {
  const canonical = JSON.stringify([
    tenantId,
    req.model,
    req.messages.map((m) => [m.role, m.content]),
    req.temperature ?? null,
    req.top_p ?? null,
    req.max_tokens ?? null,
    req.stop ? [...req.stop].sort() : null,
  ]);
  return `${KEY_NS}:cache:${createHash('sha256').update(canonical).digest('hex')}`;
}

export class ExactCache {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
    private readonly maxBytes: number,
  ) {}

  /** Throws on Redis failure; callers treat that as a MISS. */
  async get(key: string): Promise<CachedEntry | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CachedEntry;
    } catch {
      await this.redis.del(key); // corrupt entry: drop it
      return null;
    }
  }

  /** Entries above maxBytes are skipped to bound memory. Always written with a TTL. Returns whether stored. */
  async set(key: string, entry: CachedEntry): Promise<boolean> {
    const raw = JSON.stringify(entry);
    if (Buffer.byteLength(raw) > this.maxBytes) return false;
    await this.redis.set(key, raw, 'EX', this.ttlSeconds);
    return true;
  }
}
