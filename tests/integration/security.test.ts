import pino from 'pino';
import { ADMIN, createTestEnv, uniqueBody, type TestEnv } from './helpers';

describe('security behaviour', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await createTestEnv({ REQUEST_BODY_LIMIT: '2kb', CORS_ORIGINS: 'http://allowed.example' }); });
  afterAll(async () => { await env.close(); });

  it('enforces the request size limit with a structured 413 (after authentication)', async () => {
    const t = await env.createTenant();
    const big = uniqueBody({}, 'x'.repeat(5000));
    const r = await env.chat(t.apiKey, big);
    expect(r.status).toBe(413);
    expect(r.body.error).toMatchObject({ code: 'REQUEST_TOO_LARGE', type: 'invalid_request_error' });
    // Unauthenticated callers get 401 and the body is never parsed.
    expect((await env.http().post('/v1/chat/completions').send(big)).status).toBe(401);
  });
  it('returns 400 for malformed JSON and validation errors without echoing prompt content', async () => {
    const t = await env.createTenant();
    const bad = await env.http().post('/v1/chat/completions').set('Authorization', `Bearer ${t.apiKey}`).set('Content-Type', 'application/json').send('{"model": ');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');
    const invalid = await env.chat(t.apiKey, { model: 'mock-model', temperature: 99, messages: [{ role: 'user', content: 'CANARY-SECRET-PROMPT' }] });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(invalid.body)).not.toContain('CANARY-SECRET-PROMPT');
    expect(invalid.body.error.code).toBe('INVALID_REQUEST');
  });
  it('uses one consistent error shape, including for unknown routes', async () => {
    const r = await env.http().get('/nope');
    expect(r.status).toBe(404);
    expect(r.body.error).toMatchObject({ code: 'NOT_FOUND', type: 'invalid_request_error' });
    expect(r.body.error.request_id).toBe(r.headers['x-request-id']);
  });
  it('sets security headers and hides the framework', async () => {
    const r = await env.http().get('/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['strict-transport-security']).toBeTruthy();
  });
  it('propagates a valid client X-Request-ID and replaces an invalid one', async () => {
    const ok = await env.http().get('/health').set('X-Request-ID', 'abc-12345_xyz');
    expect(ok.headers['x-request-id']).toBe('abc-12345_xyz');
    for (const bad of ['short', 'has spaces in it', 'x'.repeat(200), 'bad<script>id']) {
      const r = await env.http().get('/health').set('X-Request-ID', bad);
      expect(r.headers['x-request-id']).not.toBe(bad);
      expect(r.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
    }
  });
  it('CORS: allows only configured origins', async () => {
    const allowed = await env.http().get('/health').set('Origin', 'http://allowed.example');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://allowed.example');
    const evil = await env.http().get('/health').set('Origin', 'http://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('does not leak internals on unexpected failures (database unavailable => generic 500)', async () => {
    const e2 = await createTestEnv();
    try {
      const t = await e2.createTenant();
      await e2.pool.end(); // every query now fails
      const r = await e2.chat(t.apiKey);
      expect(r.status).toBe(500);
      expect(r.body.error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
      expect(JSON.stringify(r.body)).not.toMatch(/postgres|ECONN|password|pool|stack|at /i);
    } finally { await e2.close(); } // also closes the admin pool and drops the temporary schema
  });
  it('never writes API keys, admin tokens or prompt text to the application log', async () => {
    const lines: string[] = [];
    const original = env.deps.log;
    (env.deps as { log: typeof original }).log = pino({ level: 'trace' }, { write: (s: string) => { lines.push(s); } });
    try {
      const t = await env.createTenant();
      await env.chat(t.apiKey, uniqueBody({}, 'LOGGING-CANARY-PROMPT-777'));
      await env.chat('lgw_deadbeef_' + 'z'.repeat(43), uniqueBody());
      await env.http().get('/api/providers').set(ADMIN);
      const all = lines.join('\n');
      expect(all.length).toBeGreaterThan(0); // something was logged...
      expect(all).not.toContain(t.apiKey);
      expect(all).not.toContain('test-admin-token-');
      expect(all).not.toContain('LOGGING-CANARY-PROMPT-777'); // ...but never secrets or prompts
    } finally { (env.deps as { log: typeof original }).log = original; }
  });
  it('treats SQL/Redis metacharacters in inputs as data', async () => {
    const t = await env.createTenant();
    const r = await env.chat(t.apiKey, { model: "mock-model'; DROP TABLE tenants;--", messages: [{ role: 'user', content: '*\r\nFLUSHALL\r\n' }] });
    expect(r.status).toBe(404); // unknown model, handled normally
    expect(Number((await env.pool.query('SELECT count(*) FROM tenants')).rows[0].count)).toBeGreaterThan(0);
    const ok = await env.chat(t.apiKey, uniqueBody({}, '*\r\nFLUSHALL\r\n'));
    expect(ok.status).toBe(200);
    expect(await env.http().get('/api/requests?limit=1%27').set(ADMIN)).toMatchObject({ status: 400 });
  });
});
