const { ProviderManager, ProviderChainError } = require('./packages/providers/src/manager');
const { MockProvider } = require('./packages/providers/src/mockProvider');
const { CircuitBreaker } = require('./packages/providers/src/circuitBreaker');
const assert = require('node:assert');
const results = [];
const t = async (name, fn) => { try { await fn(); results.push('PASS ' + name); } catch (e) { results.push('FAIL ' + name + ': ' + e.message); } };
const req = { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] };
const mk = (clock, extra = {}) => {
  const a = new MockProvider({ latencyMs: 0, failureRate: 0 }, 'mock');
  const b = new MockProvider({ latencyMs: 0, failureRate: 0 }, 'mock-2');
  const events = [];
  const m = new ProviderManager(new Map([['mock', a], ['mock-2', b]]), ['mock', 'mock-2'], {
    timeoutMs: 200, totalTimeoutMs: 2000, maxRetries: 1, retryBaseDelayMs: 1,
    breaker: { failureThreshold: 3, cooldownMs: 1000, halfOpenMaxRequests: 1 },
    onEvent: (e) => events.push(e), runtime: { now: () => clock.t, sleep: async () => {}, random: () => 0.5 }, ...extra });
  return { a, b, m, events };
};
(async () => {
  await t('breaker CLOSED->OPEN->HALF_OPEN->CLOSED', async () => {
    const c = { t: 0 }; const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100, halfOpenMaxRequests: 1, now: () => c.t });
    b.onFailure(b.tryAcquire()); assert.equal(b.getState(), 'CLOSED');
    b.onFailure(b.tryAcquire()); assert.equal(b.getState(), 'OPEN');
    assert.equal(b.tryAcquire().allowed, false);
    c.t = 100; const g = b.tryAcquire(); assert.equal(g.allowed, true); assert.equal(b.getState(), 'HALF_OPEN');
    assert.equal(b.tryAcquire().allowed, false, 'only 1 probe');
    b.onSuccess(g); assert.equal(b.getState(), 'CLOSED');
  });
  await t('breaker HALF_OPEN failure -> OPEN again', async () => {
    const c = { t: 0 }; const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10, halfOpenMaxRequests: 1, now: () => c.t });
    b.onFailure(b.tryAcquire()); c.t = 10; const g = b.tryAcquire(); b.onFailure(g); assert.equal(b.getState(), 'OPEN');
  });
  await t('stale success cannot close an OPEN breaker', async () => {
    const c = { t: 0 }; const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, halfOpenMaxRequests: 1, now: () => c.t });
    const slow = b.tryAcquire(); b.onFailure(b.tryAcquire()); assert.equal(b.getState(), 'OPEN');
    b.onSuccess(slow); assert.equal(b.getState(), 'OPEN');
  });
  await t('fallback: primary 503 -> secondary succeeds', async () => {
    const { a, m } = mk({ t: 0 }); a.setFailureMode('http_503');
    const o = await m.complete(req, { requestId: 'r1' });
    assert.equal(o.provider, 'mock-2'); assert.equal(o.fallbackUsed, true);
    assert.equal(o.attempts.filter((x) => x.provider === 'mock').length, 2, 'initial + 1 retry');
  });
  await t('bad_request is NOT retried or failed over', async () => {
    const { a, m, events } = mk({ t: 0 }); a.setFailureMode('bad_request');
    try { await m.complete(req, { requestId: 'r2' }); assert.fail('should throw'); }
    catch (e) { assert(e instanceof ProviderChainError); assert.equal(e.error.kind, 'bad_request'); assert.equal(e.attempts.length, 1); }
  });
  await t('all providers fail -> chain error with last error', async () => {
    const { a, b, m } = mk({ t: 0 }); a.setFailureMode('http_500'); b.setFailureMode('http_503');
    try { await m.complete(req, { requestId: 'r3' }); assert.fail(); } catch (e) { assert(e instanceof ProviderChainError); assert.equal(e.error.kind, 'upstream_5xx'); }
  });
  await t('timeout triggers fallback and is not retried', async () => {
    const { a, m } = mk({ t: 0 }); a.setFailureMode('timeout');
    const o = await m.complete(req, { requestId: 'r4' });
    assert.equal(o.provider, 'mock-2'); assert.equal(o.attempts.filter((x) => x.provider === 'mock').length, 1);
    assert.equal(o.attempts[0].outcome, 'timeout');
  });
  await t('breaker opens after threshold, traffic skips provider, then recovers', async () => {
    const c = { t: 0 }; const { a, m, events } = mk(c); a.setFailureMode('http_500');
    for (let i = 0; i < 3; i++) await m.complete(req, { requestId: 'x' + i }); // each request: 2 attempts on mock
    assert.equal(m.status()[0].circuit.state, 'OPEN');
    const before = a.getFailureMode();
    const o = await m.complete(req, { requestId: 'skip' });
    assert(o.attempts.some((x) => x.provider === 'mock' && x.outcome === 'circuit_open'));
    a.setFailureMode('none'); c.t = 1000;
    const o2 = await m.complete(req, { requestId: 'probe' });
    assert.equal(o2.provider, 'mock'); assert.equal(m.status()[0].circuit.state, 'CLOSED');
    const trans = events.filter((e) => e.type === 'breaker').map((e) => e.from + '>' + e.to);
    assert.deepEqual(trans, ['CLOSED>OPEN', 'OPEN>HALF_OPEN', 'HALF_OPEN>CLOSED']);
  });
  await t('disabled primary -> fallback flagged', async () => {
    const { m } = mk({ t: 0 }); m.setEnabled('mock', false);
    const o = await m.complete(req, { requestId: 'd1' });
    assert.equal(o.provider, 'mock-2'); assert.equal(o.fallbackUsed, true);
    assert.equal(m.status()[0].health, 'disabled');
  });
  await t('all disabled -> none_available; unknown model -> model_not_found', async () => {
    const { m } = mk({ t: 0 }); m.setEnabled('mock', false); m.setEnabled('mock-2', false);
    await assert.rejects(m.complete(req, { requestId: 'd2' }), (e) => e.reason === 'none_available');
    await assert.rejects(m.complete({ ...req, model: 'nope' }, { requestId: 'd3' }), (e) => e.reason === 'model_not_found');
  });
  await t('client abort stops the chain and does not trip the breaker', async () => {
    const { a, m } = mk({ t: 0 }); a.setFailureMode('timeout');
    const ac = new AbortController(); setTimeout(() => ac.abort(), 20);
    await assert.rejects(m.complete(req, { requestId: 'c1', clientSignal: ac.signal }), (e) => e.error.kind === 'client_abort');
    assert.equal(m.status()[0].circuit.consecutiveFailures, 0);
  });
  console.log(results.join('\n'));
})();
