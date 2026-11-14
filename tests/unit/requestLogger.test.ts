import { RequestLogger, type RequestLogEntry } from '../../packages/database/src/requestLogger';

const COLS = 18;
const entry = (i: number): RequestLogEntry => ({
  requestId: `r${i}`, tenantId: null, apiKeyId: null, provider: 'mock', model: 'm', inputTokens: 1, outputTokens: 1, totalTokens: 2,
  tokensEstimated: false, latencyMs: 5, statusCode: 200, cacheStatus: 'MISS', streamed: false, estimatedCostUsd: null,
  estimatedSavingsUsd: null, fallbackUsed: false, errorType: null, createdAt: new Date(),
});
type Q = (sql: string, params: unknown[]) => Promise<unknown>;
function make(query: Q, over: Partial<ConstructorParameters<typeof RequestLogger>[1]> = {}) {
  const clock = { t: 0 }; const logs: string[] = []; let dropped = 0;
  const l = new RequestLogger({ query } as never, {
    maxQueue: 10, batchSize: 4, flushIntervalMs: 1000, now: () => clock.t,
    log: { warn: (_o, m) => logs.push(m), error: (_o, m) => logs.push(m) }, onDrop: (n) => { dropped += n; }, ...over,
  });
  return { l, clock, logs, dropped: () => dropped };
}

describe('RequestLogger', () => {
  it('writes a batch as one multi-row INSERT with the right parameters', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const { l } = make(async (sql, p) => { calls.push([sql, p]); });
    for (let i = 0; i < 3; i++) l.enqueue(entry(i));
    await l.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toHaveLength(3 * COLS);
    expect(l.stats()).toMatchObject({ written: 3, queued: 0 });
  });
  it('enqueue is synchronous and never waits on the database', () => {
    const { l } = make(() => new Promise(() => undefined));
    expect(l.enqueue(entry(1))).toBeUndefined();
  });
  it('keeps entries through a DB outage, honours backoff, and recovers without loss', async () => {
    let down = true; let rows = 0;
    const { l, clock } = make(async (_s, p) => { if (down) throw new Error('refused'); rows += p.length / COLS; });
    for (let i = 0; i < 3; i++) l.enqueue(entry(i));
    await l.flush();
    expect(l.stats()).toMatchObject({ queued: 3, consecutiveFailures: 1 });
    await l.flush();
    expect(l.stats().consecutiveFailures).toBe(1); // still backing off
    down = false; clock.t = 1000;
    await l.flush();
    expect(rows).toBe(3);
    expect(l.stats()).toMatchObject({ queued: 0, dropped: 0 });
  });
  it('drops the OLDEST entries on overflow and counts them', () => {
    const { l, dropped, logs } = make(async () => { throw new Error('down'); }, { batchSize: 1000 });
    for (let i = 0; i < 15; i++) l.enqueue(entry(i));
    expect(l.stats().queued).toBe(10);
    expect(dropped()).toBe(5);
    expect(logs).toContain('request log queue full; oldest entries dropped');
  });
  it('on overflow keeps the NEWEST entries (r5..r14) and writes them in order once the DB recovers', async () => {
    let down = true; const ids: string[] = [];
    const { l, clock } = make(async (_s, p) => { if (down) throw new Error('down'); for (let i = 0; i < p.length; i += COLS) ids.push(String(p[i])); }, { batchSize: 1000 });
    for (let i = 0; i < 15; i++) l.enqueue(entry(i));
    down = false; clock.t = 5000;
    await l.flush();
    expect(ids).toEqual(['r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14']);
  });
  it('isolates a poison row (constraint violation) without losing the good rows', async () => {
    const written: unknown[] = [];
    const { l, dropped } = make(async (_s, p) => {
      const ids: unknown[] = []; for (let i = 0; i < p.length; i += COLS) ids.push(p[i]);
      if (ids.includes('r1')) throw Object.assign(new Error('fk'), { code: '23503' });
      written.push(...ids);
    });
    for (let i = 0; i < 3; i++) l.enqueue(entry(i));
    await l.flush();
    expect(written).toEqual(['r0', 'r2']);
    expect(dropped()).toBe(1);
  });
  it('flushes everything on close()', async () => {
    let rows = 0;
    const { l } = make(async (_s, p) => { rows += p.length / COLS; });
    for (let i = 0; i < 6; i++) l.enqueue(entry(i));
    expect(await l.close()).toBe(0);
    expect(rows).toBe(6);
  });
  it('close() with the DB down reports and logs the unwritten entries instead of hanging', async () => {
    const { l, logs } = make(async () => { throw new Error('down'); });
    l.enqueue(entry(1)); l.enqueue(entry(2));
    expect(await l.close(200)).toBe(2);
    expect(logs.filter((m) => m === 'request log not persisted at shutdown')).toHaveLength(2);
  });
});
