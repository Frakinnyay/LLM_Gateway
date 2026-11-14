import { createTestEnv, sleep, uniqueBody, type TestEnv } from './helpers';

describe('Redis token-bucket rate limiting', () => {
  describe('capacity 5, near-zero refill', () => {
    let env: TestEnv;
    beforeAll(async () => { env = await createTestEnv({ RATE_LIMIT_CAPACITY: '5', RATE_LIMIT_REFILL_PER_SEC: '0.01' }); });
    afterAll(async () => { await env.close(); });

    it('allows up to capacity then rejects with 429, Retry-After and the standard error body', async () => {
      const t = await env.createTenant();
      const statuses: number[] = [];
      let last: Awaited<ReturnType<TestEnv['chat']>> | undefined;
      for (let i = 0; i < 7; i++) { last = await env.chat(t.apiKey); statuses.push(last.status); }
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
      expect(Number(last!.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(last!.headers['x-ratelimit-limit']).toBe('5');
      expect(last!.body.error).toMatchObject({ type: 'rate_limit_error', code: 'RATE_LIMIT_EXCEEDED' });
    });
    it('is per tenant: one tenant exhausting its bucket does not affect another', async () => {
      const a = await env.createTenant(), b = await env.createTenant();
      for (let i = 0; i < 6; i++) await env.chat(a.apiKey);
      expect((await env.chat(a.apiKey)).status).toBe(429);
      expect((await env.chat(b.apiKey)).status).toBe(200);
    });
    it('CONCURRENCY: 40 simultaneous requests admit exactly the bucket capacity (no read-modify-write race)', async () => {
      const t = await env.createTenant();
      const results = await Promise.all(Array.from({ length: 40 }, () => env.chat(t.apiKey, uniqueBody())));
      expect(results.filter((r) => r.status === 200)).toHaveLength(5);
      expect(results.filter((r) => r.status === 429)).toHaveLength(35);
    });
    it('CONCURRENCY: the limiter itself admits exactly `capacity` of 200 parallel consumes', async () => {
      const t = await env.createTenant();
      const results = await Promise.all(Array.from({ length: 200 }, () => env.deps.rateLimiter.consume(t.tenantId)));
      expect(results.filter((r) => r.allowed)).toHaveLength(5);
    });
    it('rate-limited requests never reach the provider or the budget', async () => {
      const t = await env.createTenant();
      for (let i = 0; i < 5; i++) await env.chat(t.apiKey);
      const calls = env.mock().calls;
      expect((await env.chat(t.apiKey)).status).toBe(429);
      expect(env.mock().calls).toBe(calls);
    });
  });

  describe('token refill', () => {
    let env: TestEnv;
    beforeAll(async () => { env = await createTestEnv({ RATE_LIMIT_CAPACITY: '2', RATE_LIMIT_REFILL_PER_SEC: '20' }); });
    afterAll(async () => { await env.close(); });
    it('refills over time (20 tokens/s => >=1 token after 150 ms)', async () => {
      const t = await env.createTenant();
      const limiter = env.deps.rateLimiter; // direct calls: a full HTTP request takes long enough to refill tokens between attempts
      expect((await limiter.consume(t.tenantId)).allowed).toBe(true);
      expect((await limiter.consume(t.tenantId)).allowed).toBe(true);
      expect((await limiter.consume(t.tenantId)).allowed).toBe(false);
      await sleep(150);
      expect((await limiter.consume(t.tenantId)).allowed).toBe(true);
    });
    it('never refills above capacity', async () => {
      const t = await env.createTenant();
      await sleep(300);
      const r = await Promise.all(Array.from({ length: 10 }, () => env.deps.rateLimiter.consume(t.tenantId)));
      expect(r.filter((x) => x.allowed).length).toBeLessThanOrEqual(3); // capacity 2 (+ at most 1 refilled during the burst)
    });
  });

  describe('when Redis is unavailable', () => {
    it('fails open by default (request served, budget still enforced in Postgres)', async () => {
      const env = await createTestEnv();
      try {
        const t = await env.createTenant();
        env.redis.disconnect();
        const r = await env.chat(t.apiKey);
        expect(r.status).toBe(200);
      } finally { await env.close(); }
    });
    it('fails closed with 503 when RATE_LIMIT_FAIL_OPEN=false', async () => {
      const env = await createTestEnv({ RATE_LIMIT_FAIL_OPEN: 'false' });
      try {
        const t = await env.createTenant();
        env.redis.disconnect();
        const r = await env.chat(t.apiKey);
        expect(r.status).toBe(503);
        expect(r.body.error.code).toBe('RATE_LIMITER_UNAVAILABLE');
      } finally { await env.close(); }
    });
  });
});
