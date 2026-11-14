import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { ChatRequest, Usage } from '../../providers/src/types';

export interface SemanticInput {
  /** Text that is embedded: ONLY the final user message. */
  text: string;
  /** Hash binding model, generation params and ALL earlier messages (system prompt + history). */
  contextHash: string;
}

/**
 * Correctness rule: only the last user message may differ semantically. Model, params, system
 * prompt and prior turns must match EXACTLY (via contextHash), otherwise a "similar" question
 * asked under a different system prompt or model could receive an incompatible answer.
 * Returns null (semantic cache skipped) when the request does not end in a user message.
 */
export function buildSemanticInput(req: ChatRequest): SemanticInput | null {
  const last = req.messages[req.messages.length - 1];
  if (!last || last.role !== 'user') return null;
  const history = req.messages.slice(0, -1).map((m) => [m.role, m.content]);
  const contextHash = createHash('sha256').update(JSON.stringify([
    req.model, history, req.temperature ?? null, req.top_p ?? null, req.max_tokens ?? null,
    req.stop ? [...req.stop].sort() : null,
  ])).digest('hex');
  return { text: last.content, contextHash };
}

export interface SemanticHit {
  response: Record<string, unknown>;
  provider: string;
  similarity: number;
  model: string;
  usage: Usage | null; // usage reported by the provider when the entry was created
}

export interface LookupResult {
  hit: SemanticHit | null;
  /** Similarity of the nearest candidate even when below threshold (null if none). Useful for tuning. */
  bestSimilarity: number | null;
}

const toVectorLiteral = (v: number[]): string => `[${v.join(',')}]`;

/**
 * pgvector-backed second-level cache. Scoped by tenant_id + context_hash; the nearest
 * neighbour by cosine distance is accepted only if similarity (1 - distance) >= threshold.
 * Note: the HNSW index is approximate and the tenant/context filter is applied while scanning,
 * so a very selective filter can yield a false MISS (never a wrong HIT).
 */
export class SemanticCache {
  constructor(
    private readonly pool: Pool,
    private readonly threshold: number,
    private readonly ttlSeconds: number,
  ) {}

  async lookup(tenantId: string, contextHash: string, embedding: number[]): Promise<LookupResult> {
    const r = await this.pool.query<{ id: string; response: Record<string, unknown>; provider: string; model: string; input_tokens: number | null; output_tokens: number | null; similarity: number }>(
      `SELECT id, response, provider, model, input_tokens, output_tokens, 1 - (embedding <=> $3::vector) AS similarity
         FROM semantic_cache
        WHERE tenant_id = $1 AND context_hash = $2 AND expires_at > now()
        ORDER BY embedding <=> $3::vector
        LIMIT 1`,
      [tenantId, contextHash, toVectorLiteral(embedding)],
    );
    const row = r.rows[0];
    if (!row) return { hit: null, bestSimilarity: null };
    const similarity = Number(row.similarity);
    if (similarity < this.threshold) return { hit: null, bestSimilarity: similarity };
    void this.pool.query('UPDATE semantic_cache SET hit_count = hit_count + 1 WHERE id = $1', [row.id]).catch(() => undefined);
    const usage: Usage | null = row.input_tokens != null && row.output_tokens != null
      ? { promptTokens: row.input_tokens, completionTokens: row.output_tokens, totalTokens: row.input_tokens + row.output_tokens, estimated: false }
      : null;
    return { hit: { response: row.response, provider: row.provider, similarity, model: row.model, usage }, bestSimilarity: similarity };
  }

  async store(args: {
    tenantId: string; contextHash: string; model: string; promptText: string; embedding: number[];
    response: Record<string, unknown>; provider: string; usage: Usage | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO semantic_cache
         (tenant_id, context_hash, model, prompt_text, embedding, response, provider, input_tokens, output_tokens, expires_at)
       VALUES ($1,$2,$3,$4,$5::vector,$6::jsonb,$7,$8,$9, now() + make_interval(secs => $10))`,
      [args.tenantId, args.contextHash, args.model, args.promptText, toVectorLiteral(args.embedding),
        JSON.stringify(args.response), args.provider, args.usage?.promptTokens ?? null,
        args.usage?.completionTokens ?? null, this.ttlSeconds],
    );
  }

  /** Deletes expired rows; run periodically to bound table growth. */
  async purgeExpired(): Promise<number> {
    const r = await this.pool.query('DELETE FROM semantic_cache WHERE expires_at <= now()');
    return r.rowCount ?? 0;
  }
}
