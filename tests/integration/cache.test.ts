import { HashingEmbeddingProvider, cosineSimilarity } from '../../packages/cache/src/embedding';
import { createTestEnv, sleep, uniqueBody, type TestEnv } from './helpers';

describe('exact cache', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await createTestEnv({ EXACT_CACHE_TTL_SECONDS: '1' }); });
  afterAll(async () => { await env.close(); });

  it('MISS then HIT with an identical body, without a second provider call', async () => {
    const t = await env.createTenant();
    const b = uniqueBody();
    const first = await env.chat(t.apiKey, b);
    expect(first.headers['x-cache']).toBe('MISS');
    const calls = env.mock().calls + env.mock('mock-2').calls;
    const second = await env.chat(t.apiKey, b);
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.headers['x-cache-type']).toBe('exact');
    expect(second.body).toEqual(first.body);
    expect(env.mock().calls + env.mock('mock-2').calls).toBe(calls);
  });
  it.each([
    ['temperature', { temperature: 0.9 }],
    ['top_p', { top_p: 0.5 }],
    ['max_tokens', { max_tokens: 33 }],
    ['stop', { stop: ['END'] }],
  ])('a different %s is a MISS (never returns an answer generated with other parameters)', async (_n, change) => {
    const t = await env.createTenant();
    const b = uniqueBody({ temperature: 0.2 });
    await env.chat(t.apiKey, b);
    const r = await env.chat(t.apiKey, { ...b, ...change });
    expect(r.headers['x-cache']).toBe('MISS');
  });
  it('does not share entries across tenants', async () => {
    const a = await env.createTenant(), b = await env.createTenant();
    const body = uniqueBody();
    await env.chat(a.apiKey, body);
    expect((await env.chat(b.apiKey, body)).headers['x-cache']).toBe('MISS');
  });
  it('expires entries after the TTL', async () => {
    const t = await env.createTenant();
    const b = uniqueBody();
    await env.chat(t.apiKey, b);
    expect((await env.chat(t.apiKey, b)).headers['x-cache']).toBe('HIT');
    await sleep(1300);
    expect((await env.chat(t.apiKey, b)).headers['x-cache']).toBe('MISS');
  });
  it('every stored key carries a TTL (bounded growth)', async () => {
    const t = await env.createTenant();
    await env.chat(t.apiKey, uniqueBody());
    const keys = await env.redis.keys('llmgw:v1:cache:*');
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys.slice(0, 5)) expect(await env.redis.ttl(k)).toBeGreaterThan(-1);
  });
  it('honours Cache-Control: no-cache (skip read, refresh) and no-store (skip read and write)', async () => {
    const t = await env.createTenant();
    const b = uniqueBody();
    await env.chat(t.apiKey, b);
    const nc = await env.chat(t.apiKey, b, { 'Cache-Control': 'no-cache' });
    expect(nc.headers['x-cache']).toBe('BYPASS');
    const b2 = uniqueBody();
    expect((await env.chat(t.apiKey, b2, { 'Cache-Control': 'no-store' })).headers['x-cache']).toBe('BYPASS');
    expect((await env.chat(t.apiKey, b2)).headers['x-cache']).toBe('MISS'); // no-store wrote nothing
  });
  it('degrades to a MISS (not an error) when Redis is down', async () => {
    const e2 = await createTestEnv();
    try {
      const t = await e2.createTenant();
      e2.redis.disconnect();
      const r = await e2.chat(t.apiKey);
      expect(r.status).toBe(200);
    } finally { await e2.close(); }
  });
  it('CONCURRENCY: simultaneous identical requests all succeed with identical content, and the entry is then served from cache', async () => {
    const t = await env.createTenant();
    const b = uniqueBody();
    const rs = await Promise.all(Array.from({ length: 10 }, () => env.chat(t.apiKey, b)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(new Set(rs.map((r) => r.body.choices[0].message.content)).size).toBe(1);
    expect((await env.chat(t.apiKey, b)).headers['x-cache']).toBe('HIT');
    // Known limitation (documented): no single-flight, so concurrent misses may each call the provider.
  });
});

describe('semantic cache', () => {
  const embedder = new HashingEmbeddingProvider();
  const A = 'explain vector databases please', B = 'explain vector databases';
  let sim = 0;
  beforeAll(async () => {
    sim = cosineSimilarity(await embedder.embed(A), await embedder.embed(B));
    if (!(sim > 0.3 && sim < 0.999)) throw new Error(`test precondition: similarity ${sim} must be in (0.3, 0.999)`);
  });
  const below = () => (Math.floor((sim - 0.001) * 10000) / 10000).toString();
  const above = () => (Math.ceil((sim + 0.001) * 10000) / 10000).toString();

  describe('similarity above the threshold', () => {
    let env: TestEnv;
    beforeAll(async () => { env = await createTestEnv({ SEMANTIC_CACHE_ENABLED: 'true', SEMANTIC_CACHE_THRESHOLD: below() }); });
    afterAll(async () => { await env.close(); });

    it('serves a semantic HIT for a similar prompt, reports similarity, and does not call the provider or charge budget', async () => {
      const t = await env.createTenant();
      const seed = await env.chat(t.apiKey, uniqueBody({}, A));
      expect(seed.headers['x-cache']).toBe('MISS');
      const calls = env.mock().calls;
      const used = (await env.pool.query('SELECT total_tokens FROM usage_records WHERE tenant_id=$1', [t.tenantId])).rows[0].total_tokens;
      const r = await env.chat(t.apiKey, uniqueBody({}, B));
      expect(r.headers['x-cache']).toBe('HIT');
      expect(r.headers['x-cache-type']).toBe('semantic');
      expect(Number(r.headers['x-semantic-similarity'])).toBeCloseTo(sim, 2);
      expect(r.body).toEqual(seed.body);
      expect(env.mock().calls).toBe(calls);
      expect((await env.pool.query('SELECT total_tokens FROM usage_records WHERE tenant_id=$1', [t.tenantId])).rows[0].total_tokens).toBe(used);
    });
    it('never matches across a different system prompt, temperature or tenant', async () => {
      const t = await env.createTenant(), other = await env.createTenant();
      const withSystem = (sys: string, user: string, extra = {}) => ({ model: 'mock-model', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], ...extra });
      await env.chat(t.apiKey, withSystem('be brief', A));
      expect((await env.chat(t.apiKey, withSystem('be verbose', B))).headers['x-cache']).toBe('MISS');
      expect((await env.chat(t.apiKey, withSystem('be brief', B, { temperature: 0.7 }))).headers['x-cache']).toBe('MISS');
      expect((await env.chat(other.apiKey, withSystem('be brief', B))).headers['x-cache']).toBe('MISS');
      expect((await env.chat(t.apiKey, withSystem('be brief', B))).headers['x-cache-type']).toBe('semantic'); // control: same context does match
    });
  });

  describe('similarity below the threshold', () => {
    let env: TestEnv;
    beforeAll(async () => { env = await createTestEnv({ SEMANTIC_CACHE_ENABLED: 'true', SEMANTIC_CACHE_THRESHOLD: above() }); });
    afterAll(async () => { await env.close(); });
    it('is a MISS and still reports the nearest similarity for tuning', async () => {
      const t = await env.createTenant();
      await env.chat(t.apiKey, uniqueBody({}, A));
      const r = await env.chat(t.apiKey, uniqueBody({}, B));
      expect(r.headers['x-cache']).toBe('MISS');
      expect(Number(r.headers['x-semantic-similarity'])).toBeCloseTo(sim, 2);
    });
  });

  it('ignores expired semantic entries', async () => {
    const env = await createTestEnv({ SEMANTIC_CACHE_ENABLED: 'true', SEMANTIC_CACHE_THRESHOLD: below(), SEMANTIC_CACHE_TTL_SECONDS: '1' });
    try {
      const t = await env.createTenant();
      await env.chat(t.apiKey, uniqueBody({}, A));
      await sleep(1300);
      expect((await env.chat(t.apiKey, uniqueBody({}, B))).headers['x-cache']).toBe('MISS');
      expect(await env.deps.semanticCache.purgeExpired()).toBeGreaterThanOrEqual(1);
    } finally { await env.close(); }
  });
});
