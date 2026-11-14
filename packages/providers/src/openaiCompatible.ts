import { z } from 'zod';
import type {
  CallContext, ChatRequest, ChatResult, LLMProvider, ModelInfo, ProviderHealth, StreamChunk, Usage,
} from './types';
import { ProviderError } from './types';
import { readSSEData } from './sseParser';
import type { ProviderErrorKind } from './types';

export interface OpenAICompatibleOptions {
  includeStreamUsage?: boolean;
  baseUrl: string; // from validated config ONLY — never from request data (SSRF boundary)
  apiKey: string;
  models: string[];
}

const upstreamSchema = z.object({
  id: z.string().optional(),
  created: z.number().optional(),
  model: z.string().optional(),
  choices: z.array(z.object({
    index: z.number().optional(),
    message: z.object({ role: z.string().optional(), content: z.string().nullable() }),
    finish_reason: z.string().nullable().optional(),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number().optional(),
  }).optional(),
});

const streamChunkSchema = z.object({
  id: z.string().optional(),
  created: z.number().optional(),
  choices: z.array(z.object({
    index: z.number().optional(),
    delta: z.object({ role: z.string().optional(), content: z.string().nullable().optional() }).default({}),
    finish_reason: z.string().nullable().optional(),
  })).default([]),
  usage: z.object({
    prompt_tokens: z.number(), completion_tokens: z.number(), total_tokens: z.number().optional(),
  }).nullable().optional(),
});

function classifyStatus(status: number): ProviderErrorKind {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'unsupported_model';
  if (status >= 500) return 'upstream_5xx';
  return 'bad_request';
}

/** Adapter for any provider exposing the OpenAI chat-completions wire format (Groq, Gemini's OpenAI endpoint, OpenRouter). */
export class OpenAICompatibleProvider implements LLMProvider {
  constructor(readonly name: string, private readonly opts: OpenAICompatibleOptions) {}

  isConfigured(): boolean { return this.opts.apiKey.length > 0; }
  listModels(): ModelInfo[] { return this.opts.models.map((id) => ({ id })); }
  supportsModel(model: string): boolean { return this.opts.models.includes(model); }

  async chatCompletion(req: ChatRequest, ctx: CallContext): Promise<ChatResult> {
    // Whitelist forwarded fields; nothing else from the client reaches the provider.
    const payload = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature,
      top_p: req.top_p,
      max_tokens: req.max_tokens,
      stop: req.stop,
      stream: false,
    };
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.apiKey}`,
          'x-request-id': ctx.requestId,
        },
        body: JSON.stringify(payload),
        signal: ctx.signal,
        redirect: 'error', // never follow redirects: credentials must only ever go to the configured provider URL
      });
    } catch (err) {
      const aborted = ctx.signal.aborted || (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError';
      throw new ProviderError(this.name, aborted ? 'timeout' : 'network', aborted ? 'provider timed out' : 'network failure');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined); // never surface upstream error bodies
      throw new ProviderError(this.name, classifyStatus(res.status), `upstream status ${res.status}`, res.status);
    }

    let parsed: z.infer<typeof upstreamSchema>;
    try {
      parsed = upstreamSchema.parse(await res.json());
    } catch (err) {
      const aborted = ctx.signal.aborted;
      throw new ProviderError(this.name, aborted ? 'timeout' : 'malformed_response',
        aborted ? 'provider timed out' : 'provider returned an unexpected response');
    }

    const u = parsed.usage;
    const usage: Usage | null = u
      ? { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens,
          totalTokens: u.total_tokens ?? u.prompt_tokens + u.completion_tokens, estimated: false }
      : null;

    // Normalised OpenAI-compatible body (drops provider-specific extras).
    const body: Record<string, unknown> = {
      id: parsed.id ?? `chatcmpl-${ctx.requestId}`,
      object: 'chat.completion',
      created: parsed.created ?? Math.floor(Date.now() / 1000),
      model: req.model,
      choices: parsed.choices.map((c, i) => ({
        index: c.index ?? i,
        message: { role: 'assistant', content: c.message.content ?? '' },
        finish_reason: c.finish_reason ?? 'stop',
      })),
      ...(usage && {
        usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens },
      }),
    };
    return { body, usage, model: req.model };
  }

  async *streamChatCompletion(req: ChatRequest, ctx: CallContext): AsyncIterable<StreamChunk> {
    const payload = {
      model: req.model, messages: req.messages, temperature: req.temperature, top_p: req.top_p,
      max_tokens: req.max_tokens, stop: req.stop, stream: true,
      ...(this.opts.includeStreamUsage && { stream_options: { include_usage: true } }),
    };
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${this.opts.apiKey}`,
          'x-request-id': ctx.requestId,
        },
        body: JSON.stringify(payload),
        signal: ctx.signal,
        redirect: 'error', // never follow redirects: credentials must only ever go to the configured provider URL
      });
    } catch (err) {
      const aborted = ctx.signal.aborted || (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError';
      throw new ProviderError(this.name, aborted ? 'timeout' : 'network', aborted ? 'provider timed out' : 'network failure');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new ProviderError(this.name, classifyStatus(res.status), `upstream status ${res.status}`, res.status);
    }
    if (!res.body) throw new ProviderError(this.name, 'malformed_response', 'provider returned no stream body');

    const id = `chatcmpl-${ctx.requestId}`;
    let created = Math.floor(Date.now() / 1000);
    let sawDone = false;
    let sawFinish = false;
    try {
      for await (const data of readSSEData(res.body, this.name)) {
        if (data.trim() === '[DONE]') { sawDone = true; break; }
        let parsed: z.infer<typeof streamChunkSchema>;
        try {
          parsed = streamChunkSchema.parse(JSON.parse(data));
        } catch {
          throw new ProviderError(this.name, 'malformed_response', 'provider returned an unexpected stream chunk');
        }
        if (parsed.created) created = parsed.created;
        if (parsed.choices.some((c) => c.finish_reason)) sawFinish = true;
        const u = parsed.usage;
        const usage: Usage | undefined = u
          ? { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens,
              totalTokens: u.total_tokens ?? u.prompt_tokens + u.completion_tokens, estimated: false }
          : undefined;
        // Normalised chunk; provider-specific extras are dropped.
        yield {
          data: {
            id, object: 'chat.completion.chunk', created, model: req.model,
            choices: parsed.choices.map((c, i) => ({
              index: c.index ?? i,
              delta: { ...(c.delta.role && { role: c.delta.role }), ...(c.delta.content != null && { content: c.delta.content }) },
              finish_reason: c.finish_reason ?? null,
            })),
          },
          ...(usage && { usage }),
        };
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const aborted = ctx.signal.aborted;
      throw new ProviderError(this.name, aborted ? 'timeout' : 'network', aborted ? 'provider stream timed out' : 'provider stream interrupted');
    } finally {
      await res.body.cancel().catch(() => undefined);
    }
    if (!sawDone && !sawFinish) throw new ProviderError(this.name, 'network', 'provider stream ended unexpectedly');
  }

  /** No network call: a paid-API health probe on every poll would cost quota. Circuit breaker supplies real state. */
  async healthCheck(): Promise<ProviderHealth> {
    return { name: this.name, configured: this.isConfigured(), reachable: 'unknown' };
  }
}
