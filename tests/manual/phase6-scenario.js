// Manual scenario checks (Phase 9 converts these to Jest). Run after compiling: node phase6-scenario.js
const { ProviderManager, ProviderChainError } = require('./packages/providers/src/manager');
const { MockProvider } = require('./packages/providers/src/mockProvider');
const { readSSEData } = require('./packages/providers/src/sseParser');
const assert = require('node:assert');
const out = [];
const t = async (n, f) => { try { await f(); out.push('PASS ' + n); } catch (e) { out.push('FAIL ' + n + ': ' + e.message); } };
const req = { model: 'mock-model', messages: [{ role: 'user', content: 'tell me something long enough to chunk' }] };
const mk = (o = {}) => {
  const a = new MockProvider({ latencyMs: 0, failureRate: 0 }, 'mock'), b = new MockProvider({ latencyMs: 0, failureRate: 0 }, 'mock-2');
  const m = new ProviderManager(new Map([['mock', a], ['mock-2', b]]), ['mock', 'mock-2'], {
    timeoutMs: 200, totalTimeoutMs: 2000, maxRetries: 0, retryBaseDelayMs: 1, streamIdleTimeoutMs: 100, streamMaxDurationMs: 5000,
    breaker: { failureThreshold: 2, cooldownMs: 1000, halfOpenMaxRequests: 1 }, ...o });
  return { a, b, m };
};
const drain = async (h) => { const c = []; for await (const x of h.chunks) c.push(x); return c; };
const stream = (chunks) => new ReadableStream({ start(c) { const e = new TextEncoder(); chunks.forEach((x) => c.enqueue(e.encode(x))); c.close(); } });
const collect = async (rs) => { const r = []; for await (const d of readSSEData(rs)) r.push(d); return r; };

(async () => {
  await t('stream happy path yields role, content, finish', async () => {
    const { m } = mk(); const h = await m.openStream(req, { requestId: 's1' }); const c = await drain(h);
    assert(c.length >= 3); assert.equal(c[0].data.choices[0].delta.role, 'assistant');
    assert.equal(c[c.length - 1].data.choices[0].finish_reason, 'stop'); assert(c[c.length - 1].usage);
    assert.equal(m.status()[0].circuit.state, 'CLOSED');
  });
  await t('failure BEFORE first chunk falls back to next provider', async () => {
    const { a, m } = mk(); a.setFailureMode('http_503');
    const h = await m.openStream(req, { requestId: 's2' }); assert.equal(h.provider, 'mock-2'); assert.equal(h.fallbackUsed, true); await drain(h);
  });
  await t('failure MID-stream is surfaced, NOT failed over, and counts against breaker', async () => {
    const { a, b, m } = mk(); a.setFailureMode('stream_cut');
    const h = await m.openStream(req, { requestId: 's3' }); assert.equal(h.provider, 'mock');
    const got = []; let err;
    try { for await (const c of h.chunks) got.push(c); } catch (e) { err = e; }
    assert(err && err.kind === 'network'); assert(got.length >= 2 && got.length < 6);
    assert.equal(m.status()[0].circuit.consecutiveFailures, 1);
  });
  await t('consumer cancel (client disconnect) releases without breaker failure', async () => {
    const { m } = mk(); const h = await m.openStream(req, { requestId: 's4' });
    const it = h.chunks; await it.next(); await it.return();
    assert.equal(m.status()[0].circuit.consecutiveFailures, 0); assert.equal(m.status()[0].circuit.state, 'CLOSED');
  });
  await t('time-to-first-chunk timeout falls back', async () => {
    const { a, m } = mk(); a.setFailureMode('timeout');
    const h = await m.openStream(req, { requestId: 's5' }); assert.equal(h.provider, 'mock-2'); await drain(h);
  });
  await t('bad_request on stream is not failed over', async () => {
    const { a, m } = mk(); a.setFailureMode('bad_request');
    await assert.rejects(m.openStream(req, { requestId: 's6' }), (e) => e instanceof ProviderChainError && e.error.kind === 'bad_request');
  });
  await t('idle timeout mid-stream aborts with timeout error', async () => {
    const { a, m } = mk({ streamIdleTimeoutMs: 30 });
    const slow = new MockProvider({ latencyMs: 0, failureRate: 0 }, 'slow');
    const orig = slow.streamChatCompletion.bind(slow);
    slow.streamChatCompletion = async function* (r, ctx) { let i = 0; for await (const c of orig(r, ctx)) { yield c; if (++i === 2) await new Promise((res, rej) => { const t = setTimeout(res, 2000); ctx.signal.addEventListener('abort', () => { clearTimeout(t); rej(new (require('./packages/providers/src/types').ProviderError)('slow', 'timeout', 'aborted')); }); }); } };
    const mm = new ProviderManager(new Map([['slow', slow]]), ['slow'], { timeoutMs: 200, totalTimeoutMs: 2000, maxRetries: 0, retryBaseDelayMs: 1, streamIdleTimeoutMs: 30, streamMaxDurationMs: 5000, breaker: { failureThreshold: 5, cooldownMs: 1000, halfOpenMaxRequests: 1 } });
    const h = await mm.openStream(req, { requestId: 's7' }); let err; try { await drain(h); } catch (e) { err = e; }
    assert(err && err.kind === 'timeout');
  });
  await t('SSE parser: split chunks, CRLF, comments, multi-line data', async () => {
    const r = await collect(stream(['da', 'ta: {"a":1}\r\n\r', '\n: keep-alive\n\ndata: x\ndata: y\n\n', 'data: [DONE]\n\n']));
    assert.deepEqual(r, ['{"a":1}', 'x\ny', '[DONE]']);
  });
  await t('SSE parser: multibyte char split across chunks, final event without blank line', async () => {
    const bytes = new TextEncoder().encode('data: héllo\n\ndata: tail'); const a = bytes.slice(0, 9), b = bytes.slice(9);
    const rs = new ReadableStream({ start(c) { c.enqueue(a); c.enqueue(b); c.close(); } });
    assert.deepEqual(await collect(rs), ['héllo', 'tail']);
  });
  console.log(out.join('\n'));
})();
