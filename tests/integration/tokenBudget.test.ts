import { TokenBudget } from '../../packages/rate-limit/src/tokenBudget';
import { createTestEnv, uniqueBody, type TestEnv } from './helpers';

// With content of 1-3 chars the input estimate is 1 token, so a request with max_tokens=100 reserves exactly 101.
const RESERVE = 101;
const body = (content: string) => uniqueBody({ max_tokens: 100 }, content);

describe('monthly token budget', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await createTestEnv({ MOCK_PROVIDER_LATENCY_MS: '150' }); });
  afterAll(async () => { await env.close(); });

  const usage = async (tenantId: string) =>
    (await env.pool.query('SELECT total_tokens, reserved_tokens, input_tokens, output_tokens FROM usage_records WHERE tenant_id=$1', [tenantId])).rows[0];

  it('serves a request that fits and records actual usage; reservation is returned', async () => {
    const t = await env.createTenant({ budget: 100_000 });
    expect((await env.chat(t.apiKey, body('hi'))).status).toBe(200);
    const u = await usage(t.tenantId);
    expect(Number(u.reserved_tokens)).toBe(0);
    expect(Number(u.total_tokens)).toBe(Number(u.input_tokens) + Number(u.output_tokens));
    expect(Number(u.total_tokens)).toBeGreaterThan(0);
  });
  it('allows a request whose reservation exactly equals the budget', async () => {
    const t = await env.createTenant({ budget: RESERVE });
    expect((await env.chat(t.apiKey, body('hi'))).status).toBe(200);
  });
  it('rejects with 429 TOKEN_BUDGET_EXCEEDED when the reservation does not fit, without calling the provider', async () => {
    const t = await env.createTenant({ budget: RESERVE - 1 });
    const calls = env.mock().calls;
    const r = await env.chat(t.apiKey, body('hi'));
    expect(r.status).toBe(429);
    expect(r.body.error).toMatchObject({ type: 'budget_exceeded_error', code: 'TOKEN_BUDGET_EXCEEDED' });
    expect(env.mock().calls).toBe(calls);
  });
  it('rejects a follow-up once remaining budget is below the next reservation', async () => {
    const t = await env.createTenant({ budget: RESERVE });
    expect((await env.chat(t.apiKey, body('aa'))).status).toBe(200);
    expect((await env.chat(t.apiKey, body('bb'))).status).toBe(429); // ~6 used, 95 left < 101
  });
  it('releases the reservation when every provider fails', async () => {
    const t = await env.createTenant({ budget: 10_000 });
    env.mock('mock').setFailureMode('http_500'); env.mock('mock-2').setFailureMode('http_500');
    try {
      expect((await env.chat(t.apiKey, body('hi'))).status).toBe(502);
      const u = await usage(t.tenantId);
      expect(Number(u.reserved_tokens)).toBe(0);
      expect(Number(u.total_tokens)).toBe(0);
    } finally { env.mock('mock').setFailureMode('none'); env.mock('mock-2').setFailureMode('none'); }
  });
  it('does not charge cache hits', async () => {
    const t = await env.createTenant({ budget: 100_000 });
    const b = body('cacheme');
    expect((await env.chat(t.apiKey, b)).headers['x-cache']).toBe('MISS');
    const before = Number((await usage(t.tenantId)).total_tokens);
    const hit = await env.chat(t.apiKey, b);
    expect(hit.headers['x-cache']).toBe('HIT');
    expect(Number((await usage(t.tenantId)).total_tokens)).toBe(before);
  });
  it('CONCURRENCY: 10 simultaneous requests against a budget for exactly 3 reservations admit exactly 3', async () => {
    const t = await env.createTenant({ budget: RESERVE * 3 });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => env.chat(t.apiKey, body(`q${i}`))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 429)).toHaveLength(7);
    const u = await usage(t.tenantId);
    expect(Number(u.reserved_tokens)).toBe(0);
    expect(Number(u.total_tokens)).toBeLessThanOrEqual(RESERVE * 3);
  });

  describe('TokenBudget (direct)', () => {
    it('CONCURRENCY: 50 parallel reservations of 10 against a budget of 100 succeed exactly 10 times', async () => {
      const t = await env.createTenant();
      const budget = new TokenBudget(env.pool);
      const r = await Promise.all(Array.from({ length: 50 }, () => budget.reserve(t.tenantId, 100, 10)));
      expect(r.filter((x) => x.ok)).toHaveLength(10);
    });
    it('release() makes the budget available again', async () => {
      const t = await env.createTenant();
      const budget = new TokenBudget(env.pool);
      const first = await budget.reserve(t.tenantId, 10, 10);
      expect(first.ok).toBe(true);
      expect((await budget.reserve(t.tenantId, 10, 1)).ok).toBe(false);
      if (first.ok) await budget.release(first.reservation);
      expect((await budget.reserve(t.tenantId, 10, 10)).ok).toBe(true);
    });
    it('monthly reset: an exhausted month does not affect the next UTC month', async () => {
      const t = await env.createTenant();
      const budget = new TokenBudget(env.pool);
      const nov = new Date('2026-11-15T00:00:00Z'), dec = new Date('2026-12-01T00:00:00Z');
      expect((await budget.reserve(t.tenantId, 10, 10, nov)).ok).toBe(true);
      expect((await budget.reserve(t.tenantId, 10, 1, nov)).ok).toBe(false);
      expect((await budget.reserve(t.tenantId, 10, 10, dec)).ok).toBe(true);
    });
    it('settle() replaces the reservation with actual usage', async () => {
      const t = await env.createTenant();
      const budget = new TokenBudget(env.pool);
      const r = await budget.reserve(t.tenantId, 1000, 500);
      if (!r.ok) throw new Error('reserve failed');
      await budget.settle(r.reservation, { input: 30, output: 70 });
      const u = (await env.pool.query('SELECT * FROM usage_records WHERE tenant_id=$1', [t.tenantId])).rows[0];
      expect([Number(u.reserved_tokens), Number(u.input_tokens), Number(u.output_tokens), Number(u.total_tokens)]).toEqual([0, 30, 70, 100]);
    });
  });
});
