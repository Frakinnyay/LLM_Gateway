#!/usr/bin/env node
/**
 * End-to-end API smoke test against a RUNNING gateway (no dependencies, Node >= 20). Cross-platform.
 *   node scripts/smoke.js [--wait]
 * Env: GATEWAY_URL (default http://localhost:8080), ADMIN_API_TOKEN (or read from ./.env), MODEL (default mock-model).
 * Requires a provider serving MODEL (the default mock provider needs no API key). Exits non-zero on the first failed check.
 */
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const base = (process.env.GATEWAY_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const model = process.env.MODEL ?? 'mock-model';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adminToken() {
  if (process.env.ADMIN_API_TOKEN) return process.env.ADMIN_API_TOKEN;
  const f = join(__dirname, '..', '.env');
  if (existsSync(f)) { const m = /^ADMIN_API_TOKEN=(.+)$/m.exec(readFileSync(f, 'utf8')); if (m) return m[1].trim(); }
  throw new Error('ADMIN_API_TOKEN not found (set the env var or create .env with `npm run setup`)');
}
async function call(path, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, headers: res.headers, text, json };
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try { if ((await call('/ready')).status === 200) return; } catch { /* not up yet */ }
    await sleep(1000);
  }
  throw new Error(`gateway at ${base} not ready after 120 s`);
}

async function main() {
  if (process.argv.includes('--wait')) await waitReady();
  const admin = { authorization: `Bearer ${adminToken()}` };
  const prompt = `smoke test ${Date.now()}`;
  let apiKey, ctx = {};
  const steps = [
    ['GET /health is 200', async () => expect((await call('/health')).status === 200, 'health not 200')],
    ['GET /ready is 200 (Postgres + Redis reachable)', async () => { const r = await call('/ready'); expect(r.status === 200, `ready is ${r.status}: ${r.text}`); }],
    ['unknown route returns the standard JSON error with a request id', async () => {
      const r = await call('/nope'); expect(r.status === 404 && r.json?.error?.code === 'NOT_FOUND' && r.json.error.request_id, `bad 404 shape: ${r.text}`);
    }],
    ['admin API rejects a missing/incorrect token', async () => {
      expect((await call('/api/providers')).status === 401, 'no token accepted');
      expect((await call('/api/providers', { headers: { authorization: 'Bearer wrong' } })).status === 401, 'wrong token accepted');
    }],
    ['admin API lists providers', async () => { const r = await call('/api/providers', { headers: admin }); expect(r.status === 200 && r.json.data.length > 0, `providers: ${r.status} ${r.text}`); ctx.providers = r.json.data; }],
    ['create tenant + API key (plaintext returned once)', async () => {
      const t = await call('/api/tenants', { method: 'POST', headers: admin, body: { name: `smoke-${Date.now()}`, monthly_token_budget: 1000000 } });
      expect(t.status === 201, `tenant: ${t.status} ${t.text}`);
      const k = await call('/api/keys', { method: 'POST', headers: admin, body: { tenant_id: t.json.id, label: 'smoke' } });
      expect(k.status === 201 && /^lgw_/.test(k.json.api_key), `key: ${k.status} ${k.text}`);
      apiKey = k.json.api_key; ctx.keyId = k.json.id;
    }],
    ['chat completion without a key is rejected (401)', async () => expect((await call('/v1/chat/completions', { method: 'POST', body: { model, messages: [{ role: 'user', content: 'x' }] } })).status === 401, 'unauthenticated chat not 401')],
    ['chat completion works (OpenAI-compatible body)', async () => {
      const r = await call('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: { model, messages: [{ role: 'user', content: prompt }] } });
      expect(r.status === 200, `chat: ${r.status} ${r.text}`);
      expect(r.json.object === 'chat.completion' && typeof r.json.choices?.[0]?.message?.content === 'string', 'not an OpenAI-style completion');
      expect(r.headers.get('x-cache') === 'MISS', `expected X-Cache MISS, got ${r.headers.get('x-cache')}`);
      expect(r.headers.get('x-request-id'), 'missing X-Request-ID');
    }],
    ['identical request is served from the exact cache', async () => {
      const r = await call('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: { model, messages: [{ role: 'user', content: prompt }] } });
      expect(r.status === 200 && r.headers.get('x-cache') === 'HIT' && r.headers.get('x-cache-type') === 'exact', `expected exact HIT, got ${r.status} ${r.headers.get('x-cache')}`);
    }],
    ['streaming request returns SSE chunks and [DONE]', async () => {
      const r = await call('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: { model, stream: true, messages: [{ role: 'user', content: `${prompt} stream` }] } });
      expect(r.status === 200 && (r.headers.get('content-type') ?? '').includes('text/event-stream'), `stream: ${r.status} ${r.headers.get('content-type')}`);
      expect(r.text.trimEnd().endsWith('data: [DONE]'), 'stream did not end with [DONE]');
      expect(r.text.split('\n\n').filter((e) => e.startsWith('data: {')).length >= 2, 'fewer than 2 data chunks');
    }],
    ['Prometheus metrics are exposed', async () => { const r = await call('/metrics', { headers: admin }); expect(r.status === 200 && r.text.includes('gateway_requests_total'), `metrics: ${r.status}`); }],
    ['revoked key stops working', async () => {
      expect((await call(`/api/keys/${ctx.keyId}`, { method: 'DELETE', headers: admin })).status === 204, 'revoke failed');
      expect((await call('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: { model, messages: [{ role: 'user', content: 'x' }] } })).status === 401, 'revoked key still works');
    }],
  ];
  let failed = 0;
  for (const [name, fn] of steps) {
    try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); break; }
  }
  console.log(failed ? '\nSMOKE TEST FAILED' : `\nSMOKE TEST PASSED (${steps.length} checks against ${base})`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(`SMOKE TEST ERROR: ${e.message}`); process.exit(1); });
