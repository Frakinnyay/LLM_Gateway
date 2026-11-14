import http from 'node:http';
import { createTestEnv, parseSSE, uniqueBody, waitFor, type TestEnv } from './helpers';

describe('SSE streaming', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await createTestEnv({ MOCK_PROVIDER_LATENCY_MS: '40', PROVIDER_TIMEOUT_MS: '500', STREAM_IDLE_TIMEOUT_MS: '500', CB_FAILURE_THRESHOLD: '50' }); });
  afterAll(async () => { await env.close(); });
  beforeEach(() => { for (const n of ['mock', 'mock-2']) env.mock(n).setFailureMode('none'); });
  const stream = (key: string, content: string) => env.chat(key, uniqueBody({ stream: true }, content));
  const raw = (key: string, content: string): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> => new Promise((resolve, reject) => {
    const req = http.request({ port: env.port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } }, (res) => resolve({ req, res }));
    req.on('error', reject);
    req.end(JSON.stringify(uniqueBody({ stream: true }, content)));
  });

  it('returns correct SSE headers, role/content/finish chunks and a [DONE] terminator', async () => {
    const t = await env.createTenant();
    const r = await stream(t.apiKey, 'tell me about streaming responses today');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    expect(r.headers['cache-control']).toContain('no-cache');
    expect(r.headers['x-accel-buffering']).toBe('no');
    expect(r.headers['x-request-id']).toBeTruthy();
    const events = parseSSE(r.text);
    expect(events[events.length - 1]).toBe('[DONE]');
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(chunks[0].choices[0].delta.role).toBe('assistant');
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');
    const text = chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('');
    expect(text).toBe('[mock] You said: tell me about streaming responses today');
    expect(chunks.length).toBeGreaterThan(4);
  });
  it('forwards chunks incrementally: the first event arrives well before the stream ends', async () => {
    const t = await env.createTenant();
    const { res } = await raw(t.apiKey, 'one two three four five six seven eight nine ten eleven twelve');
    const times: number[] = [];
    await new Promise<void>((resolve) => { res.on('data', () => times.push(Date.now())); res.on('end', () => resolve()); });
    expect(times.length).toBeGreaterThan(1);
    expect(times[times.length - 1]! - times[0]!).toBeGreaterThanOrEqual(100); // not buffered into one write at the end
  });
  it('falls back when the primary fails before the first chunk', async () => {
    const t = await env.createTenant();
    env.mock('mock').setFailureMode('http_503');
    const r = await stream(t.apiKey, 'fallback while streaming please');
    expect(r.status).toBe(200);
    expect(r.headers['x-provider']).toBe('mock-2');
    expect(r.headers['x-fallback-used']).toBe('true');
    expect(parseSSE(r.text).pop()).toBe('[DONE]');
  });
  it('returns a normal JSON error (not an SSE stream) when no provider can start the stream', async () => {
    const t = await env.createTenant();
    env.mock('mock').setFailureMode('http_500'); env.mock('mock-2').setFailureMode('http_500');
    const r = await stream(t.apiKey, 'everything is down');
    expect(r.status).toBe(502);
    expect(r.headers['content-type']).toContain('application/json');
  });
  it('mid-stream provider failure: partial chunks, an in-band error event, NO [DONE], and no failover', async () => {
    const t = await env.createTenant();
    env.mock('mock').setFailureMode('stream_cut');
    const before = env.mock('mock-2').calls;
    const r = await stream(t.apiKey, 'this stream will be cut halfway through');
    expect(r.status).toBe(200);
    const events = parseSSE(r.text);
    expect(events).not.toContain('[DONE]');
    expect(JSON.parse(events[events.length - 1]!).error).toMatchObject({ type: 'provider_error' });
    expect(events.length).toBeGreaterThan(2);
    expect(env.mock('mock-2').calls).toBe(before);
  });
  it('replays a cache hit as SSE', async () => {
    const t = await env.createTenant();
    const body = uniqueBody({}, 'cached then streamed');
    await env.chat(t.apiKey, body);
    const r = await env.chat(t.apiKey, { ...body, stream: true });
    expect(r.headers['x-cache']).toBe('HIT');
    const events = parseSSE(r.text);
    expect(events[events.length - 1]).toBe('[DONE]');
    expect(events.map((e) => (e === '[DONE]' ? '' : (JSON.parse(e).choices[0].delta.content ?? ''))).join('')).toContain('cached then streamed');
  });
  it('a completed stream populates the cache for later non-streaming requests', async () => {
    const t = await env.createTenant();
    const content = 'populate cache from a stream';
    await stream(t.apiKey, content);
    expect(await waitFor(async () => (await env.chat(t.apiKey, uniqueBody({}, content))).headers['x-cache'] === 'HIT')).toBe(true);
  });
  it('client disconnect mid-stream cancels upstream, frees the budget reservation and does not hurt the breaker', async () => {
    const t = await env.createTenant();
    const failuresBefore = env.deps.providers.status().find((p) => p.name === 'mock')!.circuit.consecutiveFailures;
    const { req, res } = await raw(t.apiKey, 'a b c d e f g h i j k l m n o p q r s t u v w x y z');
    await new Promise<void>((resolve) => res.once('data', () => resolve()));
    req.destroy(); res.destroy();
    const settled = await waitFor(async () => {
      const row = (await env.pool.query('SELECT reserved_tokens FROM usage_records WHERE tenant_id=$1', [t.tenantId])).rows[0];
      return !!row && Number(row.reserved_tokens) === 0;
    });
    expect(settled).toBe(true);
    const status = env.deps.providers.status().find((p) => p.name === 'mock')!;
    expect(status.circuit.consecutiveFailures).toBe(failuresBefore); // a cancel is neutral, not a failure
  });
});
