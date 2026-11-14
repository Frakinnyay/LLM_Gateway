import { createTestEnv, uniqueBody, type TestEnv } from './helpers';

describe('asynchronous request logging & usage records', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await createTestEnv({ RATE_LIMIT_CAPACITY: '4', RATE_LIMIT_REFILL_PER_SEC: '0.01' }); });
  afterAll(async () => { await env.close(); });
  const row = async (requestId: string) => { await env.flushLogs(); return (await env.pool.query('SELECT * FROM request_logs WHERE request_id=$1', [requestId])).rows[0]; };

  it('records provider, model, tokens, latency, status, cache status and estimated cost for a served request', async () => {
    const t = await env.createTenant();
    const r = await env.chat(t.apiKey, uniqueBody());
    const l = await row(r.headers['x-request-id']!);
    expect(l).toMatchObject({ tenant_id: t.tenantId, api_key_id: t.keyId, provider: 'mock', model: 'mock-model', status_code: 200, cache_status: 'MISS', streamed: false, fallback_used: false, error_type: null });
    expect(l.input_tokens).toBeGreaterThan(0);
    expect(l.total_tokens).toBe(l.input_tokens + l.output_tokens);
    expect(l.latency_ms).toBeGreaterThanOrEqual(0);
    expect(l.estimated_cost_usd).not.toBeNull(); // pricing.json has an illustrative wildcard mock price
  });
  it('records cache hits with cost 0 and an estimated saving', async () => {
    const t = await env.createTenant();
    const b = uniqueBody();
    await env.chat(t.apiKey, b);
    const hit = await env.chat(t.apiKey, b);
    const l = await row(hit.headers['x-request-id']!);
    expect(l.cache_status).toBe('HIT_EXACT');
    expect(Number(l.estimated_cost_usd)).toBe(0);
    expect(Number(l.estimated_savings_usd)).toBeGreaterThan(0);
  });
  it('records fallback usage and failed requests with an error type', async () => {
    const t = await env.createTenant();
    env.mock('mock').setFailureMode('http_500');
    const fb = await env.chat(t.apiKey, uniqueBody());
    expect((await row(fb.headers['x-request-id']!)).fallback_used).toBe(true);
    env.mock('mock-2').setFailureMode('http_500');
    const failed = await env.chat(t.apiKey, uniqueBody());
    const l = await row(failed.headers['x-request-id']!);
    expect(l).toMatchObject({ status_code: 502, error_type: 'PROVIDER_ERROR' });
    env.mock('mock').setFailureMode('none'); env.mock('mock-2').setFailureMode('none');
  });
  it('records rate-limited requests (cache not consulted => BYPASS) with the error code', async () => {
    const t = await env.createTenant();
    let last;
    for (let i = 0; i < 6; i++) last = await env.chat(t.apiKey, uniqueBody());
    expect(last!.status).toBe(429);
    const l = await row(last!.headers['x-request-id']!);
    expect(l).toMatchObject({ status_code: 429, error_type: 'RATE_LIMIT_EXCEEDED', cache_status: 'BYPASS', provider: null });
  });
  it('records streamed requests', async () => {
    const t = await env.createTenant();
    const r = await env.chat(t.apiKey, uniqueBody({ stream: true }));
    const l = await row(r.headers['x-request-id']!);
    expect(l).toMatchObject({ streamed: true, status_code: 200, provider: 'mock' });
  });
  it('does not persist unauthenticated requests (cannot be used to flood the table)', async () => {
    const before = Number((await env.pool.query('SELECT count(*) FROM request_logs')).rows[0].count);
    await env.http().post('/v1/chat/completions').send(uniqueBody());
    await env.flushLogs();
    expect(Number((await env.pool.query('SELECT count(*) FROM request_logs')).rows[0].count)).toBe(before);
  });
  it('updates usage_records and exposes it through the admin API', async () => {
    const t = await env.createTenant();
    await env.chat(t.apiKey, uniqueBody());
    const u = (await env.pool.query('SELECT total_tokens FROM usage_records WHERE tenant_id=$1', [t.tenantId])).rows[0];
    expect(Number(u.total_tokens)).toBeGreaterThan(0);
    const api = await env.http().get(`/api/usage?tenant_id=${t.tenantId}`).set({ Authorization: `Bearer ${'test-admin-token-' + 'y'.repeat(32)}` });
    expect(api.status).toBe(200);
    expect(api.body.history[0].total_tokens).toBe(Number(u.total_tokens));
  });
  it('request IDs link the response header, the error body and the log row', async () => {
    const t = await env.createTenant();
    const r = await env.chat(t.apiKey, uniqueBody(), { 'X-Request-ID': 'client-supplied-id-12345' });
    expect(r.headers['x-request-id']).toBe('client-supplied-id-12345');
    expect((await row('client-supplied-id-12345'))?.tenant_id).toBe(t.tenantId);
  });
});
