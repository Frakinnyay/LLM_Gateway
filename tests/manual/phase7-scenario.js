const { RequestLogger } = require('./packages/database/src/requestLogger');
const assert = require('node:assert');
const out = []; const t = async (n, f) => { try { await f(); out.push('PASS ' + n); } catch (e) { out.push('FAIL ' + n + ': ' + e.message); } };
const entry = (i) => ({ requestId: 'r' + i, tenantId: null, apiKeyId: null, provider: 'mock', model: 'm', inputTokens: 1, outputTokens: 1, totalTokens: 2, tokensEstimated: false, latencyMs: 5, statusCode: 200, cacheStatus: 'MISS', streamed: false, estimatedCostUsd: null, estimatedSavingsUsd: null, fallbackUsed: false, errorType: null, createdAt: new Date() });
const mk = (query, o = {}) => { const clock = { t: 0 }; const logs = []; let dropped = 0;
  const l = new RequestLogger({ query }, { maxQueue: 10, batchSize: 4, flushIntervalMs: 1000, now: () => clock.t, log: { warn: (a, m) => logs.push(m), error: (a, m) => logs.push(m) }, onDrop: (n) => (dropped += n), ...o });
  return { l, clock, logs, dropped: () => dropped }; };
(async () => {
  await t('batches rows into one multi-row INSERT with correct params', async () => {
    const calls = []; const { l } = mk(async (sql, p) => { calls.push([sql, p]); });
    for (let i = 0; i < 3; i++) l.enqueue(entry(i)); await l.flush();
    assert.equal(calls.length, 1); assert.equal(calls[0][1].length, 3 * 18); assert(calls[0][0].includes('($19,$20'));
    assert.equal(l.stats().written, 3); assert.equal(l.stats().queued, 0);
  });
  await t('enqueue never awaits DB (synchronous, returns undefined)', async () => {
    const { l } = mk(() => new Promise(() => {})); assert.strictEqual(l.enqueue(entry(1)), undefined);
  });
  await t('DB outage: batch retained, backoff honoured, then recovers with no loss', async () => {
    let down = true; const written = []; const { l, clock } = mk(async (sql, p) => { if (down) throw new Error('conn refused'); written.push(p.length / 18); });
    for (let i = 0; i < 3; i++) l.enqueue(entry(i));
    await l.flush(); assert.equal(l.stats().queued, 3); assert.equal(l.stats().consecutiveFailures, 1);
    await l.flush(); assert.equal(l.stats().consecutiveFailures, 1, 'backoff: no retry yet');
    down = false; clock.t = 1000; await l.flush(); assert.equal(l.stats().queued, 0); assert.equal(l.stats().written, 3); assert.equal(l.stats().dropped, 0);
  });
  await t('queue overflow drops OLDEST and counts them', async () => {
    const { l, dropped, logs } = mk(async () => { throw new Error('down'); }, { batchSize: 1000 });
    for (let i = 0; i < 15; i++) l.enqueue(entry(i)); assert.equal(l.stats().queued, 10); assert.equal(dropped(), 5); assert(logs.includes('request log queue full; oldest entries dropped'));
  });
  await t('poison row (FK violation) dropped alone; good rows persisted', async () => {
    const written = []; const { l, dropped } = mk(async (sql, p) => { const ids = []; for (let i = 0; i < p.length; i += 18) ids.push(p[i]); if (ids.includes('r1')) { const e = new Error('fk'); e.code = '23503'; throw e; } written.push(...ids); });
    for (let i = 0; i < 3; i++) l.enqueue(entry(i)); await l.flush();
    assert.deepEqual(written, ['r0', 'r2']); assert.equal(dropped(), 1); assert.equal(l.stats().queued, 0);
  });
  await t('close() flushes remaining entries', async () => {
    const written = []; const { l } = mk(async (s, p) => { written.push(p.length / 18); }); for (let i = 0; i < 6; i++) l.enqueue(entry(i));
    const left = await l.close(); assert.equal(left, 0); assert.equal(written.reduce((a, b) => a + b, 0), 6);
  });
  await t('close() with DB down reports + logs unflushed entries, does not hang', async () => {
    const { l, logs } = mk(async () => { throw new Error('down'); }); l.enqueue(entry(1)); l.enqueue(entry(2));
    const left = await l.close(200); assert.equal(left, 2); assert.equal(logs.filter((m) => m === 'request log not persisted at shutdown').length, 2);
  });
  const { estimateCost, loadPricing } = require('./packages/shared/src/pricing');
  const table = { currency: 'USD', unit: 'per_1M_tokens', prices: { '*:mock-model': { input: 0.1, output: 0.2 }, 'groq:x': { input: 1, output: 2 } } };
  const u = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500, estimated: false };
  await t('pricing: wildcard + exact lookup, null when unknown or usage missing', async () => {
    assert.equal(estimateCost(table, 'mock-2', 'mock-model', u), (1000 * 0.1 + 500 * 0.2) / 1e6);
    assert.equal(estimateCost(table, 'groq', 'x', u), (1000 * 1 + 500 * 2) / 1e6);
    assert.strictEqual(estimateCost(table, 'groq', 'unknown', u), null); assert.strictEqual(estimateCost(table, 'groq', 'x', null), null);
  });
  console.log(out.join('\n'));
})();
