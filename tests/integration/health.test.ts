import { ADMIN, createTestEnv, type TestEnv } from './helpers';

describe('health, readiness and metrics', () => {
  it('/health is alive and /ready is ready when dependencies are up', async () => {
    const env = await createTestEnv();
    try {
      expect((await env.http().get('/health')).body).toEqual({ status: 'ok' });
      const ready = await env.http().get('/ready');
      expect(ready.status).toBe(200);
      expect(ready.body).toEqual({ status: 'ready', checks: { postgres: true, redis: true } });
    } finally { await env.close(); }
  });
  it('/ready turns 503 when Redis is down while /health stays 200', async () => {
    const env = await createTestEnv();
    try {
      env.redis.disconnect();
      const ready = await env.http().get('/ready');
      expect(ready.status).toBe(503);
      expect(ready.body.checks).toEqual({ postgres: true, redis: false });
      expect((await env.http().get('/health')).status).toBe(200);
    } finally { await env.close(); }
  });
  it('provider outages (even all providers disabled) never fail /health or /ready', async () => {
    const env = await createTestEnv();
    try {
      for (const n of ['mock', 'mock-2']) await env.http().post(`/api/providers/${n}/disable`).set(ADMIN);
      expect((await env.http().get('/health')).status).toBe(200);
      expect((await env.http().get('/ready')).status).toBe(200);
    } finally { await env.close(); }
  });

  describe('/metrics', () => {
    let env: TestEnv;
    beforeAll(async () => { env = await createTestEnv(); });
    afterAll(async () => { await env.close(); });
    it('exposes the documented series with bounded labels and no tenant/key identifiers', async () => {
      const t = await env.createTenant();
      const body = { model: 'mock-model', messages: [{ role: 'user', content: 'metrics probe' }] };
      await env.chat(t.apiKey, body); await env.chat(t.apiKey, body); // miss then exact hit
      const m = await env.http().get('/metrics');
      expect(m.status).toBe(200);
      for (const name of ['gateway_requests_total', 'gateway_request_duration_seconds', 'gateway_cache_hits_total', 'gateway_cache_misses_total',
        'gateway_provider_requests_total', 'gateway_provider_failures_total', 'gateway_fallback_total', 'gateway_tokens_total',
        'gateway_estimated_cost_total', 'gateway_rate_limit_rejections_total', 'gateway_circuit_breaker_state']) {
        expect(m.text).toContain(`# TYPE ${name} `);
      }
      expect(m.text).toMatch(/gateway_requests_total\{route="chat_completions",status="200"\} 2/);
      expect(m.text).toMatch(/gateway_cache_hits_total\{type="exact"\} 1/);
      expect(m.text).toMatch(/gateway_circuit_breaker_state\{provider="mock"\} 0/);
      expect(m.text).not.toContain(t.tenantId);
      expect(m.text).not.toContain(t.apiKey);
      expect(m.text).not.toMatch(/request_id|tenant_id|api_key/);
    });
    it('uses route templates, not raw URLs, as labels', async () => {
      await env.http().get('/definitely/not/a/route/12345').send();
      const m = await env.http().get('/metrics');
      expect(m.text).not.toContain('12345');
      expect(m.text).toMatch(/route="other"/);
    });
    it('counts rate-limit rejections', async () => {
      const e2 = await createTestEnv({ RATE_LIMIT_CAPACITY: '1', RATE_LIMIT_REFILL_PER_SEC: '0.01' });
      try {
        const t = await e2.createTenant();
        await e2.chat(t.apiKey); await e2.chat(t.apiKey);
        expect((await e2.http().get('/metrics')).text).toMatch(/gateway_rate_limit_rejections_total 1/);
      } finally { await e2.close(); }
    });
    it('can require the admin token (METRICS_REQUIRE_AUTH)', async () => {
      const e2 = await createTestEnv({ METRICS_REQUIRE_AUTH: 'true' });
      try {
        expect((await e2.http().get('/metrics')).status).toBe(401);
        expect((await e2.http().get('/metrics').set(ADMIN)).status).toBe(200);
      } finally { await e2.close(); }
    });
  });
});
