import { CircuitBreaker, type BreakerOptions, type BreakerState, type Gate } from './circuitBreaker';
import type { ChatRequest, ChatResult, LLMProvider, ProviderErrorKind, StreamChunk } from './types';
import { ProviderError } from './types';

export class NoProviderError extends Error {
  constructor(public readonly reason: 'model_not_found' | 'none_available') {
    super(reason);
  }
}

export interface AttemptRecord {
  provider: string;
  outcome: 'success' | 'circuit_open' | ProviderErrorKind;
  durationMs: number;
  retry: number;
}

/** Thrown when no provider produced a result; carries what was tried (for logging/metrics). */
export class ProviderChainError extends Error {
  constructor(public readonly error: ProviderError | NoProviderError, public readonly attempts: AttemptRecord[]) {
    super('provider chain failed');
  }
}

export type ProviderEvent =
  | { type: 'attempt'; provider: string; outcome: AttemptRecord['outcome']; durationMs: number }
  | { type: 'breaker'; provider: string; from: BreakerState; to: BreakerState }
  | { type: 'fallback'; from: string; to: string };

export interface ManagerOptions {
  timeoutMs: number; // per attempt (for streams: time to first chunk)
  streamIdleTimeoutMs?: number; // max gap between stream chunks (default 30s)
  streamMaxDurationMs?: number; // hard cap on one stream (default 5 min)
  totalTimeoutMs: number; // across all attempts of one request
  maxRetries: number; // same-provider retries (network / 5xx only)
  retryBaseDelayMs: number;
  breaker: Pick<BreakerOptions, 'failureThreshold' | 'cooldownMs' | 'halfOpenMaxRequests'>;
  onEvent?: (e: ProviderEvent) => void;
  /** Injectable for tests. */
  runtime?: { now?: () => number; sleep?: (ms: number, s: AbortSignal) => Promise<void>; random?: () => number };
}

export interface ProviderStatus {
  name: string;
  configured: boolean;
  enabled: boolean;
  /** Dashboard summary. */
  health: 'healthy' | 'disabled' | 'circuit_open' | 'circuit_half_open';
  circuit: { state: BreakerState; consecutiveFailures: number; retryAfterMs: number };
  models: string[];
}

export interface CompleteOptions {
  requestId: string;
  clientSignal?: AbortSignal;
}

export interface StreamHandle {
  provider: string;
  fallbackUsed: boolean;
  attempts: AttemptRecord[];
  /** Yields every chunk including the first. Throws a ProviderError if the stream fails mid-way. Call .return() to cancel. */
  chunks: AsyncGenerator<StreamChunk, void, void>;
}

export interface CompleteOutcome {
  provider: string;
  result: ChatResult;
  attempts: AttemptRecord[];
  fallbackUsed: boolean;
}

/** Failures that count against a provider's breaker: fallback-eligible ones plus a rejected credential. */
const BREAKER_FAILURE_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
  'timeout', 'network', 'upstream_5xx', 'rate_limited', 'malformed_response', 'auth',
]);
/** Only transient connection/5xx errors are retried on the same provider. Timeouts are NOT retried (would double latency). */
const RETRYABLE_KINDS: ReadonlySet<ProviderErrorKind> = new Set(['network', 'upstream_5xx']);
const BACKOFF_CAP_MS = 2000;

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => { signal.removeEventListener('abort', done); resolve(); }, ms);
    const done = (): void => { clearTimeout(t); resolve(); };
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * Single entry point for business logic to reach providers: model routing, runtime enable/disable,
 * per-provider circuit breakers, ordered fallback and bounded retries.
 *
 * Amplification bounds per request: at most (1 + maxRetries) attempts per provider, retries only
 * for network/5xx, never while a breaker is HALF_OPEN or not CLOSED, all within one overall deadline.
 * Every retry passes through the breaker, so a failing provider trips it quickly instead of being hammered.
 */
export class ProviderManager {
  private readonly disabled = new Set<string>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly order: string[];
  private readonly sleep: (ms: number, s: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  constructor(
    private readonly providers: Map<string, LLMProvider>,
    priority: readonly string[],
    private readonly o: ManagerOptions,
  ) {
    const inPriority = priority.filter((n) => providers.has(n));
    this.order = [...inPriority, ...[...providers.keys()].filter((n) => !inPriority.includes(n))];
    this.sleep = o.runtime?.sleep ?? defaultSleep;
    this.random = o.runtime?.random ?? Math.random;
        for (const name of providers.keys()) this.breakers.set(name, this.makeBreaker(name));
  }

  private makeBreaker(name: string): CircuitBreaker {
    return new CircuitBreaker({
      ...this.o.breaker,
      now: this.o.runtime?.now,
      onStateChange: (from, to) => this.o.onEvent?.({ type: 'breaker', provider: name, from, to }),
    });
  }

  /** Replaces every breaker with a fresh CLOSED one. Used by tests to isolate cases from each other. */
  resetCircuits(): void {
    for (const name of this.providers.keys()) this.breakers.set(name, this.makeBreaker(name));
  }

  getProvider(name: string): LLMProvider | undefined { return this.providers.get(name); }
  has(name: string): boolean { return this.providers.has(name); }

  setEnabled(name: string, enabled: boolean): boolean {
    if (!this.providers.has(name)) return false;
    if (enabled) this.disabled.delete(name); else this.disabled.add(name);
    return true;
  }

  status(): ProviderStatus[] {
    return this.order.map((name) => {
      const p = this.providers.get(name) as LLMProvider;
      const circuit = (this.breakers.get(name) as CircuitBreaker).snapshot();
      const enabled = !this.disabled.has(name);
      const health = !enabled ? 'disabled'
        : circuit.state === 'OPEN' ? 'circuit_open'
        : circuit.state === 'HALF_OPEN' ? 'circuit_half_open' : 'healthy';
      return { name, configured: p.isConfigured(), enabled, health, circuit, models: p.listModels().map((m) => m.id) };
    });
  }

  /** `primary` = first configured provider for the model by priority, even if disabled; `usable` excludes disabled ones. */
  private resolve(model: string): { primary: LLMProvider; usable: LLMProvider[] } {
    const supporting = this.order
      .map((n) => this.providers.get(n) as LLMProvider)
      .filter((p) => p.isConfigured() && p.supportsModel(model));
    const primary = supporting[0];
    if (!primary) throw new NoProviderError('model_not_found');
    const usable = supporting.filter((p) => !this.disabled.has(p.name));
    if (usable.length === 0) throw new NoProviderError('none_available');
    return { primary, usable };
  }

  private normalize(err: unknown, provider: string, client?: AbortSignal): ProviderError {
    if (client?.aborted) return new ProviderError(provider, 'client_abort', 'client closed request');
    if (err instanceof ProviderError) return err;
    return new ProviderError(provider, 'network', 'unexpected provider failure');
  }

  private async runChain<T>(
    req: ChatRequest,
    opts: CompleteOptions,
    overall: AbortSignal,
    attempt: (p: LLMProvider) => Promise<T>,
    settle: 'immediate' | 'deferred',
  ): Promise<{ provider: string; value: T; attempts: AttemptRecord[]; fallbackUsed: boolean; gate: Gate; breaker: CircuitBreaker }> {
    const { primary, usable } = this.resolve(req.model);
    const now = this.o.runtime?.now ?? Date.now;
    const attempts: AttemptRecord[] = [];
    const record = (a: AttemptRecord): void => {
      attempts.push(a);
      this.o.onEvent?.({ type: 'attempt', provider: a.provider, outcome: a.outcome, durationMs: a.durationMs });
    };
    let lastError: ProviderError | null = null;

    for (const p of usable) {
      const breaker = this.breakers.get(p.name) as CircuitBreaker;
      for (let retry = 0; ; retry++) {
        if (opts.clientSignal?.aborted) {
          throw new ProviderChainError(new ProviderError(p.name, 'client_abort', 'client closed request'), attempts);
        }
        if (overall.aborted) {
          lastError = new ProviderError(p.name, 'timeout', 'overall request deadline exceeded');
          break;
        }
        const gate = breaker.tryAcquire();
        if (!gate.allowed) { record({ provider: p.name, outcome: 'circuit_open', durationMs: 0, retry }); break; }

        const started = now();
        try {
          const value = await attempt(p);
          if (settle === 'immediate') breaker.onSuccess(gate);
          record({ provider: p.name, outcome: 'success', durationMs: now() - started, retry });
          if (p.name !== primary.name) this.o.onEvent?.({ type: 'fallback', from: primary.name, to: p.name });
          return { provider: p.name, value, attempts, fallbackUsed: p.name !== primary.name, gate, breaker };
        } catch (raw) {
          const e = this.normalize(raw, p.name, opts.clientSignal);
          record({ provider: p.name, outcome: e.kind, durationMs: now() - started, retry });
          if (e.kind === 'client_abort') {
            breaker.release(gate);
            throw new ProviderChainError(e, attempts);
          }
          if (BREAKER_FAILURE_KINDS.has(e.kind)) breaker.onFailure(gate); else breaker.onSuccess(gate);
          if (!e.fallbackEligible) throw new ProviderChainError(e, attempts); // client-side problem: fallback would just repeat it
          lastError = e;
          const mayRetry = RETRYABLE_KINDS.has(e.kind) && retry < this.o.maxRetries && !gate.probe && breaker.getState() === 'CLOSED';
          if (!mayRetry) break;
          const ceiling = Math.min(BACKOFF_CAP_MS, this.o.retryBaseDelayMs * 2 ** retry);
          await this.sleep(Math.floor(this.random() * ceiling), AbortSignal.any([overall, ...(opts.clientSignal ? [opts.clientSignal] : [])]));
        }
      }
    }
    throw new ProviderChainError(lastError ?? new NoProviderError('none_available'), attempts);
  }

  async complete(req: ChatRequest, opts: CompleteOptions): Promise<CompleteOutcome> {
    const overall = AbortSignal.timeout(this.o.totalTimeoutMs);
    const r = await this.runChain(req, opts, overall, (p) => {
      const signals = [AbortSignal.timeout(this.o.timeoutMs), overall];
      if (opts.clientSignal) signals.push(opts.clientSignal);
      return p.chatCompletion(req, { requestId: opts.requestId, signal: AbortSignal.any(signals) });
    }, 'immediate');
    return { provider: r.provider, result: r.value, attempts: r.attempts, fallbackUsed: r.fallbackUsed };
  }

  /**
   * Streaming entry point. Provider selection, retries and FALLBACK happen only until the first chunk
   * arrives: once bytes have been forwarded to the client, switching providers would splice two different
   * generations, so a later failure is surfaced instead (see docs/STREAMING.md). The breaker records the
   * outcome when the stream ends: success on normal completion, failure on a provider fault mid-stream,
   * neutral if the consumer cancelled.
   */
  async openStream(req: ChatRequest, opts: CompleteOptions): Promise<StreamHandle> {
    const idleMs = this.o.streamIdleTimeoutMs ?? 30_000;
    const maxMs = this.o.streamMaxDurationMs ?? 300_000;
    const overall = AbortSignal.timeout(this.o.totalTimeoutMs);

    interface Opened { first: StreamChunk; it: AsyncIterator<StreamChunk>; ctl: AbortController; maxTimer: NodeJS.Timeout }
    const r = await this.runChain<Opened>(req, opts, overall, async (p) => {
      const ctl = new AbortController();
      const signal = opts.clientSignal ? AbortSignal.any([ctl.signal, opts.clientSignal]) : ctl.signal;
      const ttfb = setTimeout(() => ctl.abort(), this.o.timeoutMs);
      const it = p.streamChatCompletion(req, { requestId: opts.requestId, signal })[Symbol.asyncIterator]();
      try {
        const first = await it.next();
        clearTimeout(ttfb);
        if (first.done) throw new ProviderError(p.name, 'malformed_response', 'provider stream was empty');
        const maxTimer = setTimeout(() => ctl.abort(), maxMs);
        maxTimer.unref();
        return { first: first.value, it, ctl, maxTimer };
      } catch (err) {
        clearTimeout(ttfb);
        ctl.abort();
        await it.return?.().catch(() => undefined);
        throw err;
      }
    }, 'deferred');

    const { first, it, ctl, maxTimer } = r.value;
    const { gate, breaker, provider } = r;
    const normalize = this.normalize.bind(this);

    async function* chunks(): AsyncGenerator<StreamChunk, void, void> {
      let outcome: 'complete' | 'failed' | 'cancelled' = 'cancelled'; // default covers consumer .return()
      let idle: NodeJS.Timeout | undefined;
      try {
        yield first;
        for (;;) {
          idle = setTimeout(() => ctl.abort(), idleMs); // armed only while WE wait on the provider, not while the consumer is slow
          const n = await it.next();
          clearTimeout(idle);
          if (n.done) { outcome = 'complete'; return; }
          yield n.value;
        }
      } catch (err) {
        const e = normalize(err, provider, opts.clientSignal);
        outcome = e.kind === 'client_abort' ? 'cancelled' : 'failed';
        throw e;
      } finally {
        clearTimeout(idle);
        clearTimeout(maxTimer);
        ctl.abort();
        await it.return?.().catch(() => undefined);
        if (outcome === 'complete') breaker.onSuccess(gate);
        else if (outcome === 'failed') breaker.onFailure(gate);
        else breaker.release(gate);
      }
    }
    return { provider, fallbackUsed: r.fallbackUsed, attempts: r.attempts, chunks: chunks() };
  }
}
