import { randomUUID } from 'node:crypto';
import type {
  CallContext, ChatRequest, ChatResult, LLMProvider, ModelInfo, ProviderHealth, StreamChunk, Usage,
} from './types';
import { ProviderError } from './types';

export interface MockProviderOptions {
  latencyMs: number;
  failureRate: number; // 0..1 random failures
}

export type MockFailureMode = 'none' | 'http_500' | 'http_503' | 'timeout' | 'bad_request' | 'stream_cut';

import { approximateTokens } from '../../shared/src/tokens';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ProviderError('mock', 'timeout', 'aborted'));
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new ProviderError('mock', 'timeout', 'aborted')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Deterministic zero-cost provider for demos/tests. Failure behaviour can be changed
 * at runtime (setFailureMode) so fallback and circuit-breaker demos need no API keys.
 */
export class MockProvider implements LLMProvider {
  readonly name: string;
  private mode: MockFailureMode = 'none';
  /** Number of completion/stream invocations received (including ones that then fail). Used by tests to prove a provider was or wasn't contacted. */
  calls = 0;

  constructor(private readonly opts: MockProviderOptions, name = 'mock') {
    this.name = name;
  }

  setFailureMode(mode: MockFailureMode): void { this.mode = mode; }
  getFailureMode(): MockFailureMode { return this.mode; }

  isConfigured(): boolean { return true; }
  listModels(): ModelInfo[] { return [{ id: 'mock-model' }]; }
  supportsModel(model: string): boolean { return model === 'mock-model'; }

  private async maybeFail(ctx: CallContext): Promise<void> {
    await sleep(this.opts.latencyMs, ctx.signal);
    switch (this.mode) {
      case 'http_500': throw new ProviderError(this.name, 'upstream_5xx', 'mock 500', 500);
      case 'http_503': throw new ProviderError(this.name, 'upstream_5xx', 'mock 503', 503);
      case 'bad_request': throw new ProviderError(this.name, 'bad_request', 'mock 400', 400);
      case 'timeout': await sleep(24 * 3600_000, ctx.signal); break; // hangs until the timeout signal fires
      case 'none': break;
    }
    if (Math.random() < this.opts.failureRate) throw new ProviderError(this.name, 'upstream_5xx', 'mock random failure', 500);
  }

  private reply(req: ChatRequest): string {
    const last = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    return `[mock] You said: ${last.slice(0, 200)}`;
  }

  private usage(req: ChatRequest, out: string): Usage {
    const p = approximateTokens(req.messages.map((m) => m.content).join('\n'));
    const c = approximateTokens(out);
    return { promptTokens: p, completionTokens: c, totalTokens: p + c, estimated: true };
  }

  async chatCompletion(req: ChatRequest, ctx: CallContext): Promise<ChatResult> {
    this.calls++;
    await this.maybeFail(ctx);
    const text = this.reply(req);
    const usage = this.usage(req, text);
    return {
      model: req.model,
      usage,
      body: {
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: req.model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens },
      },
    };
  }

  async *streamChatCompletion(req: ChatRequest, ctx: CallContext): AsyncIterable<StreamChunk> {
    this.calls++;
    await this.maybeFail(ctx);
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const text = this.reply(req);
    const base = { id, object: 'chat.completion.chunk', created, model: req.model };
    yield { data: { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] } };
    let sent = 0;
    for (const word of text.split(/(?<= )/)) {
      await sleep(Math.min(this.opts.latencyMs, 20), ctx.signal);
      // stream_cut: connection drops after two content chunks (mid-stream failure demo)
      if (this.mode === 'stream_cut' && sent >= 2) throw new ProviderError(this.name, 'network', 'mock stream cut');
      sent++;
      yield { data: { ...base, choices: [{ index: 0, delta: { content: word }, finish_reason: null }] } };
    }
    yield { data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, usage: this.usage(req, text) };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { name: this.name, configured: true, reachable: this.mode === 'none' };
  }
}
