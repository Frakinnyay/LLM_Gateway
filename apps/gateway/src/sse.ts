import { once } from 'node:events';
import type { Response } from 'express';

/** Sends SSE headers. Call only after the provider produced its first chunk, so earlier failures can still return normal JSON errors. */
export function startSSE(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // stop nginx-style proxies from buffering the stream
  res.flushHeaders();
}

/** Writes one SSE event, honouring backpressure. Returns false if the client is gone. */
export async function writeSSE(res: Response, payload: object | string): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return false;
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (!res.write(`data: ${data}\n\n`)) {
    // Buffer full: wait for drain or for the connection to close, whichever comes first.
    const ac = new AbortController();
    await Promise.race([once(res, 'drain', { signal: ac.signal }), once(res, 'close', { signal: ac.signal })])
      .catch(() => undefined)
      .finally(() => ac.abort());
  }
  return !res.destroyed && !res.writableEnded;
}

export async function endSSE(res: Response, done: boolean): Promise<void> {
  if (done) await writeSSE(res, '[DONE]');
  if (!res.writableEnded) res.end();
}

/**
 * Replays a cached full response as an SSE stream. This is NOT provider streaming: the answer already
 * exists, so the content arrives as a single delta. Used only for cache hits when the client asked for stream:true.
 */
export async function replayCachedAsSSE(res: Response, body: Record<string, unknown>): Promise<void> {
  const choices = (body['choices'] as Array<{ message?: { content?: string }; finish_reason?: string }> | undefined) ?? [];
  const base = {
    id: body['id'] ?? 'chatcmpl-cached', object: 'chat.completion.chunk',
    created: body['created'] ?? Math.floor(Date.now() / 1000), model: body['model'],
  };
  startSSE(res);
  await writeSSE(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: choices[0]?.message?.content ?? '' }, finish_reason: null }] });
  await writeSSE(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: choices[0]?.finish_reason ?? 'stop' }] });
  await endSSE(res, true);
}
