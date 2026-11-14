import { ADMIN, createTestEnv, uniqueBody, type TestEnv } from './helpers';

describe('authentication & key management', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await createTestEnv(); });
  afterAll(async () => { await env.close(); });

  it('rejects a missing key, a malformed key and an unknown key with the same 401', async () => {
    for (const header of [undefined, 'Bearer nope', 'Bearer lgw_00000000_' + 'a'.repeat(43), 'Basic abc']) {
      const r = await env.http().post('/v1/chat/completions').set(header ? { Authorization: header } : {}).send(uniqueBody());
      expect(r.status).toBe(401);
      expect(r.body.error).toMatchObject({ type: 'authentication_error', code: 'INVALID_API_KEY' });
      expect(r.body.error.request_id).toBe(r.headers['x-request-id']);
    }
  });
  it('accepts a valid key', async () => {
    const t = await env.createTenant();
    const r = await env.chat(t.apiKey);
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message.content).toContain('[mock]');
  });
  it('rejects a revoked key immediately', async () => {
    const t = await env.createTenant();
    expect((await env.chat(t.apiKey)).status).toBe(200);
    expect((await env.http().delete(`/api/keys/${t.keyId}`).set(ADMIN)).status).toBe(204);
    expect((await env.chat(t.apiKey)).status).toBe(401);
  });
  it('rejects keys of a suspended tenant', async () => {
    const t = await env.createTenant();
    await env.pool.query("UPDATE tenants SET status='suspended' WHERE id=$1", [t.tenantId]);
    expect((await env.chat(t.apiKey)).status).toBe(401);
  });
  it('shows the plaintext key once and never stores or lists it', async () => {
    const tenant = await env.http().post('/api/tenants').set(ADMIN).send({ name: `acme-${Date.now()}`, monthly_token_budget: 1000 });
    expect(tenant.status).toBe(201);
    const created = await env.http().post('/api/keys').set(ADMIN).send({ tenant_id: tenant.body.id, label: 'ci' });
    expect(created.status).toBe(201);
    const plaintext: string = created.body.api_key;
    expect(plaintext).toMatch(/^lgw_/);

    const list = await env.http().get(`/api/keys?tenant_id=${tenant.body.id}`).set(ADMIN);
    expect(list.status).toBe(200);
    const serialised = JSON.stringify(list.body);
    expect(serialised).not.toContain(plaintext);
    expect(serialised).not.toContain('key_hash');
    expect(list.body.data[0]).toMatchObject({ prefix: created.body.prefix, status: 'active' });

    const row = (await env.pool.query('SELECT key_hash, key_prefix FROM api_keys WHERE id=$1', [created.body.id])).rows[0];
    expect(row.key_hash).not.toContain(plaintext);
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('protects admin endpoints: no token, wrong token, and a tenant API key are all rejected', async () => {
    const t = await env.createTenant();
    for (const [method, path] of [['get', '/api/providers'], ['post', '/api/tenants'], ['get', `/api/keys?tenant_id=${t.tenantId}`], ['post', '/api/providers/mock/disable']] as const) {
      expect((await env.http()[method](path)).status).toBe(401);
      expect((await env.http()[method](path).set('Authorization', 'Bearer wrong')).status).toBe(401);
      expect((await env.http()[method](path).set('Authorization', `Bearer ${t.apiKey}`)).status).toBe(401);
    }
  });
  it('lists models of enabled providers (GET /v1/models) and requires a key', async () => {
    expect((await env.http().get('/v1/models')).status).toBe(401);
    const t = await env.createTenant();
    const r = await env.http().get('/v1/models').set('Authorization', `Bearer ${t.apiKey}`);
    expect(r.status).toBe(200);
    expect(r.body.object).toBe('list');
    expect(r.body.data.map((m: { id: string }) => m.id)).toContain('mock-model');
  });
  it('rejects unsupported OpenAI parameters explicitly instead of ignoring them', async () => {
    const t = await env.createTenant();
    const r = await env.chat(t.apiKey, { ...uniqueBody(), tools: [{ type: 'function', function: { name: 'x' } }] });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/tools.*not supported/);
  });
  it('updates last_used_at on use', async () => {
    const t = await env.createTenant();
    await env.chat(t.apiKey);
    await new Promise((r) => setTimeout(r, 100)); // bookkeeping update is fire-and-forget
    const row = (await env.pool.query('SELECT last_used_at FROM api_keys WHERE id=$1', [t.keyId])).rows[0];
    expect(row.last_used_at).not.toBeNull();
  });
});
