import { ProviderChainError, ProviderManager, type ManagerOptions } from '../../packages/providers/src/manager';
import { MockProvider } from '../../packages/providers/src/mockProvider';
import type { ChatRequest, StreamChunk } from '../../packages/providers/src/types';

const REQ: ChatRequest = { model: 'mock-model', messages: [{ role: 'user', content: 'tell me something long enough to chunk' }] };

function setup(opts: Partial<ManagerOptions> = {}) {
  const clock = { t: 0 };
  const a = new MockProvider({ latencyMs: 0, failureRate: 0 }, 'mock');
  const b = new MockProvider({ latencyMs: 0, failureRate: 0 }, 'mock-2');
  const events: Array<{ type: string }> = [];
  const m = new ProviderManager(new Map([['mock', a], ['mock-2', b]]), ['mock', 'mock-2'], {
    timeoutMs: 200, totalTimeoutMs: 2000, maxRetries: 1, retryBaseDelayMs: 1, streamIdleTimeoutMs: 100, streamMaxDurationMs: 5000,
    breaker: { failureThreshold: 3, cooldownMs: 1000, halfOpenMaxRequests: 1 },
    onEvent: (e) => events.push(e),
    runtime: { now: () => clock.t, sleep: async () => undefined, random: () => 0.5 },
    ...opts,
  });
  return { a, b, m, clock, events };
}
const drain = async (it: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> => { const out: StreamChunk[] = []; for await (const c of it) out.push(c); return out; };

describe('ProviderManager.complete', () => {
  it('uses the primary when healthy', async () => {
    const { m } = setup();
    const o = await m.complete(REQ, { requestId: 'r1' });
    expect(o.provider).toBe('mock');
    expect(o.fallbackUsed).toBe(false);
    expect(o.result.usage?.totalTokens).toBeGreaterThan(0);
  });
  it('falls back on 5xx after exactly one same-provider retry', async () => {
    const { a, m } = setup(); a.setFailureMode('http_503');
    const o = await m.complete(REQ, { requestId: 'r2' });
    expect(o.provider).toBe('mock-2');
    expect(o.fallbackUsed).toBe(true);
    expect(o.attempts.filter((x) => x.provider === 'mock')).toHaveLength(2); // initial + 1 retry, then fallback
  });
  it('falls back on timeout and does NOT retry a timeout', async () => {
    const { a, m } = setup(); a.setFailureMode('timeout');
    const o = await m.complete(REQ, { requestId: 'r3' });
    expect(o.provider).toBe('mock-2');
    expect(o.attempts.filter((x) => x.provider === 'mock')).toHaveLength(1);
    expect(o.attempts[0]?.outcome).toBe('timeout');
  });
  it('does not retry or fail over on a client error (bad_request)', async () => {
    const { a, b, m } = setup(); a.setFailureMode('bad_request');
    await expect(m.complete(REQ, { requestId: 'r4' })).rejects.toMatchObject({ error: { kind: 'bad_request' } });
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(0);
  });
  it('reports the last error when every provider fails', async () => {
    const { a, b, m } = setup(); a.setFailureMode('http_500'); b.setFailureMode('http_503');
    const err = await m.complete(REQ, { requestId: 'r5' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderChainError);
    expect((err as ProviderChainError).error).toMatchObject({ kind: 'upstream_5xx' });
  });
  it('rejects unknown models and fully disabled providers distinctly', async () => {
    const { m } = setup();
    await expect(m.complete({ ...REQ, model: 'nope' }, { requestId: 'r6' })).rejects.toMatchObject({ reason: 'model_not_found' });
    m.setEnabled('mock', false); m.setEnabled('mock-2', false);
    await expect(m.complete(REQ, { requestId: 'r7' })).rejects.toMatchObject({ reason: 'none_available' });
  });
  it('treats a disabled primary as fallback and reports it in status', async () => {
    const { m } = setup(); m.setEnabled('mock', false);
    const o = await m.complete(REQ, { requestId: 'r8' });
    expect(o.provider).toBe('mock-2');
    expect(o.fallbackUsed).toBe(true);
    expect(m.status()[0]?.health).toBe('disabled');
  });
  it('opens the breaker, skips the failing provider, then recovers through HALF_OPEN', async () => {
    const { a, m, clock, events } = setup(); a.setFailureMode('http_500');
    for (let i = 0; i < 3; i++) await m.complete(REQ, { requestId: `x${i}` });
    expect(m.status()[0]?.health).toBe('circuit_open');
    const callsBefore = a.calls;
    const skipped = await m.complete(REQ, { requestId: 'skip' });
    expect(skipped.attempts.some((x) => x.provider === 'mock' && x.outcome === 'circuit_open')).toBe(true);
    expect(a.calls).toBe(callsBefore); // no traffic reaches an OPEN provider
    a.setFailureMode('none'); clock.t = 1000;
    const probe = await m.complete(REQ, { requestId: 'probe' });
    expect(probe.provider).toBe('mock');
    expect(m.status()[0]?.health).toBe('healthy');
    const transitions = (events as Array<{ type: string; from?: string; to?: string }>).filter((e) => e.type === 'breaker').map((e) => `${e.from}>${e.to}`);
    expect(transitions).toEqual(['CLOSED>OPEN', 'OPEN>HALF_OPEN', 'HALF_OPEN>CLOSED']);
  });
  it('a client abort stops the chain and does not count as a provider failure', async () => {
    const { a, m } = setup(); a.setFailureMode('timeout');
    const ac = new AbortController(); setTimeout(() => ac.abort(), 20);
    await expect(m.complete(REQ, { requestId: 'c1', clientSignal: ac.signal })).rejects.toMatchObject({ error: { kind: 'client_abort' } });
    expect(m.status()[0]?.circuit.consecutiveFailures).toBe(0);
  });
});

describe('ProviderManager.openStream', () => {
  it('streams role, content and a final chunk with usage', async () => {
    const { m } = setup();
    const h = await m.openStream(REQ, { requestId: 's1' });
    const chunks = await drain(h.chunks);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(chunks[0]?.data)).toContain('assistant');
    expect(chunks[chunks.length - 1]?.usage).toBeTruthy();
    expect(m.status()[0]?.circuit.state).toBe('CLOSED');
  });
  it('fails over when the provider fails BEFORE the first chunk', async () => {
    const { a, m } = setup(); a.setFailureMode('http_503');
    const h = await m.openStream(REQ, { requestId: 's2' });
    expect(h.provider).toBe('mock-2');
    expect(h.fallbackUsed).toBe(true);
    await drain(h.chunks);
  });
  it('does NOT fail over on a mid-stream failure and counts it against the breaker', async () => {
    const { a, b, m } = setup(); a.setFailureMode('stream_cut');
    const h = await m.openStream(REQ, { requestId: 's3' });
    expect(h.provider).toBe('mock');
    const got: StreamChunk[] = [];
    await expect((async () => { for await (const c of h.chunks) got.push(c); })()).rejects.toMatchObject({ kind: 'network' });
    expect(got.length).toBeGreaterThanOrEqual(2);
    expect(b.calls).toBe(0);
    expect(m.status()[0]?.circuit.consecutiveFailures).toBe(1);
  });
  it('consumer cancellation releases without a breaker failure', async () => {
    const { m } = setup();
    const h = await m.openStream(REQ, { requestId: 's4' });
    await h.chunks.next(); await h.chunks.return(undefined);
    expect(m.status()[0]?.circuit.consecutiveFailures).toBe(0);
  });
  it('does not fail over a bad_request on a stream', async () => {
    const { a, m } = setup(); a.setFailureMode('bad_request');
    await expect(m.openStream(REQ, { requestId: 's5' })).rejects.toMatchObject({ error: { kind: 'bad_request' } });
  });
});
