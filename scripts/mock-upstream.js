#!/usr/bin/env node
/**
 * Deterministic OpenAI-compatible upstream for measuring GATEWAY overhead without any paid API.
 *   LATENCY_MS=50 PORT=9099 node scripts/mock-upstream.js
 * Point a gateway provider at it, e.g. GROQ_ENABLED=true GROQ_API_KEY=dummy GROQ_BASE_URL=http://localhost:9099/v1
 * Supports /v1/chat/completions (JSON and stream:true). No dependencies.
 */
const http = require('node:http');
const PORT = Number(process.env.PORT ?? 9099);
const LATENCY_MS = Number(process.env.LATENCY_MS ?? 50);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) { res.writeHead(404).end(); return; }
  if (!req.headers.authorization) { res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"missing key"}'); return; }
  let raw = '';
  for await (const c of req) raw += c;
  let body;
  try { body = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
  const last = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '';
  const text = `[upstream] ${String(last).slice(0, 100)}`;
  const id = 'chatcmpl-up-' + Date.now();
  const usage = { prompt_tokens: Math.ceil(JSON.stringify(body.messages ?? []).length / 4), completion_tokens: Math.ceil(text.length / 4) };
  await sleep(LATENCY_MS);
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
    for (const w of text.split(/(?<= )/)) res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  }));
}).listen(PORT, () => console.log(`mock upstream on :${PORT}, latency ${LATENCY_MS} ms`));
