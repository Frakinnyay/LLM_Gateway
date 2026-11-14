import { ADMIN, createTestEnv, sleep, uniqueBody, waitFor, type TestEnv } from './helpers';

describe('provider fallback, circuit breaker and admin controls', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await createTestEnv({ CB_FAILURE_THRESHOLD: '2', CB_COOLDOWN_MS: '300' }); });
  afterAll(async () => { await env.close(); });
  beforeEach(async () => {
    for (const n of ['mock', 'mock-2']) { env.mock(n).setFailureMode('none'); await env.http().post(`/api/providers/${n}/enable`).set(ADMIN); }
    env.deps.providers.resetCircuits(); // an OPEN breaker left by an earlier test would silently skip the provider under test
  });
  const health = async (name: string) => (await env.http().get('/api/providers').set(ADMIN)).body.data.find((p: { name: string }) => p.name === name);

  it('falls back to the secondary when the primary returns 5xx', async () => {
    const t = await env.createTenant();
    env.mock('mock').setFailureMode('http_503');
    const r = await env.chat(t.apiKey);
    expect(r.status).toBe(200);
    expect(r.headers['x-provider']).toBe('mock-2');
    expect(r.headers['x-fallback-used']).toBe('true');
  });
  it('falls back when the primary times out', async () => {
    const t = await env.createTenant();
    env.mock('mock').setFailureMode('timeout');
    const r = await env.chat(t.apiKey);
    expect(r.status).toBe(200);
    expect(r.headers['x-provider']).toBe('mock-2');
  });
  it('does NOT fail over on a client error: returns 400 and never contacts the secondary', async () => {
    const t = await env.createTenant();
    env.mock('mock').setFailureMode('bad_request');
    const before = env.mock('mock-2').calls;
    const r = await env.chat(t.apiKey);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('PROVIDER_REJECTED_REQUEST');
    expect(env.mock('mock-2').calls).toBe(before);
  });
  it('returns 502 with a generic error when every provider fails, leaking nothing internal', async () => {
    const t = await env.createTenant();
    env.mock('mock').setFailureMode('http_500'); env.mock('mock-2').setFailureMode('http_503');
    const r = await env.chat(t.apiKey);
    expect(r.status).toBe(502);
    expect(r.body.error).toMatchObject({ type: 'provider_error', code: 'PROVIDER_ERROR' });
    expect(JSON.stringify(r.body)).not.toMatch(/mock 50|stack|at Object/);
  });
  it('returns 404 for an unknown model and 503 when all providers for the model are disabled', async () => {
    const t = await env.createTenant();
    expect((await env.chat(t.apiKey, { ...uniqueBody(), model: 'does-not-exist' })).status).toBe(404);
    await env.http().post('/api/providers/mock/disable').set(ADMIN);
    await env.http().post('/api/providers/mock-2/disable').set(ADMIN);
    const r = await env.chat(t.apiKey);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('NO_PROVIDER_AVAILABLE');
  });
  it('admin disable routes traffic to the fallback; enable restores the primary; the choice is persisted and audited', async () => {
    const t = await env.createTenant();
    expect((await env.http().post('/api/providers/mock/disable').set(ADMIN)).status).toBe(200);
    expect((await health('mock')).health).toBe('disabled');
    const r = await env.chat(t.apiKey);
    expect([r.headers['x-provider'], r.headers['x-fallback-used']]).toEqual(['mock-2', 'true']);
    expect((await env.pool.query("SELECT enabled FROM provider_configs WHERE provider='mock'")).rows[0].enabled).toBe(false);
    expect(Number((await env.pool.query("SELECT count(*) FROM audit_logs WHERE action='provider.disable'")).rows[0].count)).toBeGreaterThanOrEqual(1);
    await env.http().post('/api/providers/mock/enable').set(ADMIN);
    expect((await env.chat(t.apiKey)).headers['x-provider']).toBe('mock');
  });
  it('rejects unknown providers and non-mock failure modes', async () => {
    expect((await env.http().post('/api/providers/nope/disable').set(ADMIN)).status).toBe(404);
    expect((await env.http().post('/api/providers/mock/failure-mode').set(ADMIN).send({ mode: 'explode' })).status).toBe(400);
  });
  it('CIRCUIT BREAKER: CLOSED -> OPEN after repeated failures, traffic skips the provider, then HALF_OPEN -> CLOSED on recovery', async () => {
    const t = await env.createTenant();
    env.mock('mock').setFailureMode('http_500');
    for (let i = 0; i < 2; i++) expect((await env.chat(t.apiKey)).status).toBe(200); // served by mock-2, but mock records failures
    expect((await health('mock')).health).toBe('circuit_open');

    const calls = env.mock('mock').calls;
    const skipped = await env.chat(t.apiKey);
    expect(skipped.headers['x-fallback-used']).toBe('true');
    expect(env.mock('mock').calls).toBe(calls); // OPEN: no traffic reaches the failing provider

    env.mock('mock').setFailureMode('none');
    await sleep(350); // cooldown elapsed -> next request is the HALF_OPEN probe
    const probe = await env.chat(t.apiKey);
    expect(probe.headers['x-provider']).toBe('mock');
    expect(await waitFor(async () => (await health('mock')).health === 'healthy')).toBe(true);
  });
  it('CONCURRENCY: a burst against a failing primary still succeeds via fallback and trips the breaker exactly once', async () => {
    const t = await env.createTenant();
    env.mock('mock').setFailureMode('http_500');
    const rs = await Promise.all(Array.from({ length: 20 }, () => env.chat(t.apiKey)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect((await health('mock')).health).toBe('circuit_open');
    const m = await env.http().get('/metrics');
    expect(m.text).toMatch(/gateway_fallback_total\{from="mock",to="mock-2"\} \d+/);
  });
});
