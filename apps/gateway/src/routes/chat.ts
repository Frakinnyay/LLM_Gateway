import { Router, type Response } from 'express';
import { estimateCost } from '../../../../packages/shared/src/pricing';
import { buildCacheKey } from '../../../../packages/cache/src/exactCache';
import { buildSemanticInput, type SemanticInput } from '../../../../packages/cache/src/semanticCache';
import { NoProviderError, ProviderChainError } from '../../../../packages/providers/src/manager';
import { ProviderError, type Usage } from '../../../../packages/providers/src/types';
import type { Reservation } from '../../../../packages/rate-limit/src/tokenBudget';
import { AppError, toErrorBody } from '../../../../packages/shared/src/errors';
import { approximateTokens } from '../../../../packages/shared/src/tokens';
import { asyncHandler } from '../middleware/common';
import { chatRequestSchema, parseOrThrow } from '../schemas';
import { endSSE, replayCachedAsSSE, startSSE, writeSSE } from '../sse';
import type { Deps } from '../types';

/** Maps provider failures to client-safe errors. Upstream messages/bodies are never forwarded. */
export function mapProviderError(raw: unknown): AppError {
  const err = raw instanceof ProviderChainError ? raw.error : raw;
  if (err instanceof NoProviderError) {
    return err.reason === 'model_not_found'
      ? new AppError(404, 'invalid_request_error', 'MODEL_NOT_FOUND', 'The requested model is not available')
      : new AppError(503, 'service_unavailable_error', 'NO_PROVIDER_AVAILABLE', 'No provider is currently available for this model');
  }
  if (err instanceof ProviderError) {
    switch (err.kind) {
      case 'bad_request': return new AppError(400, 'invalid_request_error', 'PROVIDER_REJECTED_REQUEST', 'The provider rejected the request');
      case 'unsupported_model': return new AppError(404, 'invalid_request_error', 'MODEL_NOT_FOUND', 'The requested model is not available');
      case 'client_abort': return new AppError(499, 'invalid_request_error', 'CLIENT_CLOSED_REQUEST', 'Client closed request');
      case 'timeout': return new AppError(504, 'provider_error', 'PROVIDER_TIMEOUT', 'The provider timed out');
      case 'auth': return new AppError(502, 'provider_error', 'PROVIDER_MISCONFIGURED', 'Upstream provider is misconfigured');
      default: return new AppError(502, 'provider_error', 'PROVIDER_ERROR', 'The provider failed to process the request');
    }
  }
  return new AppError(500, 'internal_error', 'INTERNAL_ERROR', 'Internal server error');
}

interface CachePrep {
  cacheKey: string;
  noStore: boolean;
  sem: SemanticInput | null;
  embedding: number[] | null;
}

export function chatRouter(deps: Deps): Router {
  const r = Router();

  const sendCached = async (res: Response, body: Record<string, unknown>, stream: boolean): Promise<void> => {
    if (stream) await replayCachedAsSSE(res, body); else res.json(body);
  };

  // OpenAI-style model list (many clients probe it): models of configured, currently enabled providers only.
  r.get('/models', (_req, res) => {
    const owner = new Map<string, string>();
    for (const p of deps.providers.status()) {
      if (!p.configured || !p.enabled) continue;
      for (const m of p.models) if (!owner.has(m)) owner.set(m, p.name);
    }
    res.json({ object: 'list', data: [...owner].map(([id, ownedBy]) => ({ id, object: 'model', created: 0, owned_by: ownedBy })) });
  });

  r.post('/chat/completions', asyncHandler(async (req, res) => {
    const auth = res.locals.auth as NonNullable<typeof res.locals.auth>;
    const requestId = res.locals.requestId;
    const body = parseOrThrow(chatRequestSchema, req.body);
    const { stream, n: _n, ...chat } = body;
    const obs = res.locals.obs;
    obs.model = chat.model;
    obs.streamed = stream;

    // 1. Rate limit (applies to cache hits too, so the cache cannot be used to bypass it).
    try {
      const rl = await deps.rateLimiter.consume(auth.tenantId);
      res.setHeader('X-RateLimit-Limit', String(rl.limit));
      res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
      if (!rl.allowed) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(rl.retryAfterMs / 1000))));
        throw new AppError(429, 'rate_limit_error', 'RATE_LIMIT_EXCEEDED', 'Rate limit exceeded');
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      deps.log.warn({ requestId, err: (err as Error).message }, 'rate limiter unavailable');
      if (!deps.cfg.RATE_LIMIT_FAIL_OPEN) {
        throw new AppError(503, 'service_unavailable_error', 'RATE_LIMITER_UNAVAILABLE', 'Rate limiter unavailable');
      }
    }

    // 2. Caches. Cache-Control: no-cache skips reads; no-store skips reads and writes.
    const cc = (req.header('cache-control') ?? '').toLowerCase();
    const noStore = cc.includes('no-store');
    const noRead = noStore || cc.includes('no-cache');
    const prep: CachePrep = {
      cacheKey: buildCacheKey(auth.tenantId, chat),
      noStore,
      sem: deps.cfg.SEMANTIC_CACHE_ENABLED ? buildSemanticInput(chat) : null,
      embedding: null,
    };
    if (noRead) {
      res.setHeader('X-Cache', 'BYPASS');
      obs.cache = 'BYPASS';
    } else {
      try {
        const hit = await deps.exactCache.get(prep.cacheKey);
        if (hit) {
          res.setHeader('X-Cache', 'HIT');
          res.setHeader('X-Cache-Type', 'exact');
          Object.assign(obs, { cache: 'HIT_EXACT', provider: hit.provider, costUsd: 0, savingsUsd: estimateCost(deps.pricing, hit.provider, hit.model, hit.usage) });
          res.setHeader('X-Provider', hit.provider);
          await sendCached(res, hit.response, stream); // cache hits consume no provider tokens: no budget charge
          return;
        }
      } catch (err) {
        deps.log.warn({ requestId, err: (err as Error).message }, 'exact cache read failed; treating as miss');
      }
      if (prep.sem) {
        try {
          prep.embedding = await deps.embedder.embed(prep.sem.text);
          const m = await deps.semanticCache.lookup(auth.tenantId, prep.sem.contextHash, prep.embedding);
          if (m.hit) {
            res.setHeader('X-Cache', 'HIT');
            res.setHeader('X-Cache-Type', 'semantic');
            Object.assign(obs, { cache: 'HIT_SEMANTIC', provider: m.hit.provider, costUsd: 0, savingsUsd: estimateCost(deps.pricing, m.hit.provider, m.hit.model, m.hit.usage) });
            res.setHeader('X-Semantic-Similarity', m.hit.similarity.toFixed(4));
            res.setHeader('X-Provider', m.hit.provider);
            await sendCached(res, m.hit.response, stream);
            return;
          }
          if (m.bestSimilarity !== null) res.setHeader('X-Semantic-Similarity', m.bestSimilarity.toFixed(4));
        } catch (err) {
          deps.log.warn({ requestId, err: (err as Error).message }, 'semantic cache lookup failed; treating as miss');
        }
      }
      res.setHeader('X-Cache', 'MISS');
      obs.cache = 'MISS';
    }

    // 3. Token budget: reserve an estimate atomically before spending provider tokens.
    const inputEstimate = approximateTokens(chat.messages.map((m) => m.content).join('\n'));
    const estimate = inputEstimate + (chat.max_tokens ?? deps.cfg.OUTPUT_TOKEN_RESERVE);
    const reserved = await deps.tokenBudget.reserve(auth.tenantId, auth.monthlyTokenBudget, estimate);
    if (!reserved.ok) {
      throw new AppError(429, 'budget_exceeded_error', 'TOKEN_BUDGET_EXCEEDED',
        `Monthly token budget exceeded: ${reserved.remaining} tokens remain, this request may need up to ${estimate}. Lower max_tokens or wait for the monthly reset.`);
    }
    const reservation: Reservation = reserved.reservation;
    const release = (): Promise<void> => deps.tokenBudget.release(reservation).catch((e) =>
      deps.log.error({ requestId, err: (e as Error).message }, 'failed to release token reservation'));
    const settle = (usage: Usage): Promise<void> =>
      deps.tokenBudget.settle(reservation, { input: usage.promptTokens, output: usage.completionTokens })
        .catch((e) => deps.log.error({ requestId, err: (e as Error).message }, 'failed to settle token usage'));
    const estimateUsage = (completionText: string): Usage => {
      const out = approximateTokens(completionText || ' ');
      return { promptTokens: inputEstimate, completionTokens: out, totalTokens: inputEstimate + out, estimated: true };
    };
    const observeSpend = (provider: string, usage: Usage, fallback: boolean): void => {
      obs.provider = provider;
      obs.usage = usage;
      obs.costUsd = estimateCost(deps.pricing, provider, chat.model, usage);
      obs.fallbackUsed = fallback;
    };
    const populateCaches = async (provider: string, response: Record<string, unknown>, usage: Usage | null): Promise<void> => {
      if (prep.noStore) return;
      await deps.exactCache.set(prep.cacheKey, {
        response, model: chat.model, provider, usage, createdAt: new Date().toISOString(),
      }).catch((e) => deps.log.warn({ requestId, err: (e as Error).message }, 'exact cache write failed'));
      if (prep.sem) {
        try {
          prep.embedding ??= await deps.embedder.embed(prep.sem.text);
          await deps.semanticCache.store({
            tenantId: auth.tenantId, contextHash: prep.sem.contextHash, model: chat.model, promptText: prep.sem.text,
            embedding: prep.embedding, response, provider, usage,
          });
        } catch (err) {
          deps.log.warn({ requestId, err: (err as Error).message }, 'semantic cache write failed');
        }
      }
    };

    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });

    // ---------- 4a. Streaming path ----------
    if (stream) {
      let handle: Awaited<ReturnType<typeof deps.providers.openStream>>;
      try {
        handle = await deps.providers.openStream(chat, { requestId, clientSignal: abort.signal });
      } catch (err) {
        await release(); // nothing was generated; headers not sent yet, so a normal JSON error is still possible
        throw mapProviderError(err);
      }
      res.setHeader('X-Provider', handle.provider);
      obs.provider = handle.provider;
      obs.fallbackUsed = handle.fallbackUsed;
      if (handle.fallbackUsed) res.setHeader('X-Fallback-Used', 'true');
      startSSE(res);

      let text = '';
      let finish: string | null = null;
      let reported: Usage | undefined;
      let completed = false;
      let failure: AppError | null = null;
      try {
        for await (const chunk of handle.chunks) {
          const choice = (chunk.data['choices'] as Array<{ delta?: { content?: string }; finish_reason?: string | null }> | undefined)?.[0];
          if (choice?.delta?.content) text += choice.delta.content;
          if (choice?.finish_reason) finish = choice.finish_reason;
          if (chunk.usage) reported = chunk.usage;
          if (choice && !(await writeSSE(res, chunk.data))) break; // client gone: leaving the loop cancels the upstream stream
        }
        completed = !abort.signal.aborted && !res.destroyed;
      } catch (err) {
        if (!abort.signal.aborted) failure = mapProviderError(err);
      }

      // Tokens were spent even if the stream ended early, so charge what was produced (estimated unless provider reported).
      const usage = reported ?? estimateUsage(text);
      await settle(usage);
      observeSpend(handle.provider, usage, handle.fallbackUsed);

      if (failure) {
        res.locals.errorCode = failure.code;
        // Headers are already sent; report the failure in-band and close without [DONE] so clients can tell it was truncated.
        deps.log.warn({ requestId, code: failure.code }, 'stream failed mid-way');
        await writeSSE(res, toErrorBody(failure, requestId));
        await endSSE(res, false);
        return;
      }
      if (completed) {
        await endSSE(res, true);
        const response = {
          id: `chatcmpl-${requestId}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: chat.model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finish ?? 'stop' }],
          ...(reported && { usage: { prompt_tokens: reported.promptTokens, completion_tokens: reported.completionTokens, total_tokens: reported.totalTokens } }),
        };
        await populateCaches(handle.provider, response, reported ?? null);
      } else if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    // ---------- 4b. Non-streaming path ----------
    let outcome: Awaited<ReturnType<typeof deps.providers.complete>>;
    try {
      outcome = await deps.providers.complete(chat, { requestId, clientSignal: abort.signal });
    } catch (err) {
      await release();
      throw mapProviderError(err);
    }
    const { provider, result, fallbackUsed } = outcome;
    if (fallbackUsed) res.setHeader('X-Fallback-Used', 'true');
    const choices = result.body['choices'] as Array<{ message?: { content?: string } }> | undefined;
    const spent = result.usage ?? estimateUsage(choices?.map((c) => c.message?.content ?? '').join('') ?? '');
    await settle(spent);
    observeSpend(provider, spent, fallbackUsed);
    await populateCaches(provider, result.body, result.usage);
    res.setHeader('X-Provider', provider);
    res.json(result.body);
  }));
  return r;
}
