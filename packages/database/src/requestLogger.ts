import type { Pool } from 'pg';

export interface RequestLogEntry {
  requestId: string;
  tenantId: string | null;
  apiKeyId: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  tokensEstimated: boolean;
  latencyMs: number;
  statusCode: number;
  cacheStatus: 'HIT_EXACT' | 'HIT_SEMANTIC' | 'MISS' | 'BYPASS';
  streamed: boolean;
  estimatedCostUsd: number | null;
  estimatedSavingsUsd: number | null;
  fallbackUsed: boolean;
  errorType: string | null;
  createdAt: Date;
}

export interface RequestLoggerOptions {
  maxQueue: number;
  batchSize: number;
  flushIntervalMs: number;
  now?: () => number;
  log?: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
  onDrop?: (count: number) => void;
}

const COLUMNS = [
  'request_id', 'tenant_id', 'api_key_id', 'provider', 'model', 'input_tokens', 'output_tokens', 'total_tokens',
  'tokens_estimated', 'latency_ms', 'status_code', 'cache_status', 'streamed', 'estimated_cost_usd',
  'estimated_savings_usd', 'fallback_used', 'error_type', 'created_at',
] as const;

const values = (e: RequestLogEntry): unknown[] => [
  e.requestId, e.tenantId, e.apiKeyId, e.provider, e.model, e.inputTokens, e.outputTokens, e.totalTokens,
  e.tokensEstimated, e.latencyMs, e.statusCode, e.cacheStatus, e.streamed, e.estimatedCostUsd,
  e.estimatedSavingsUsd, e.fallbackUsed, e.errorType, e.createdAt,
];

/**
 * Asynchronous request logger: enqueue() is synchronous and never touches the database, so request latency is
 * unaffected. A timer (or reaching batchSize) flushes batches with one multi-row INSERT.
 *
 * Failure handling (nothing is silently lost):
 *  - DB error: the batch is put back at the head of the queue and retried with exponential backoff (1s..30s).
 *  - Data/constraint error (SQLSTATE 22xxx/23xxx, e.g. a deleted tenant FK): the batch is retried row by row and only the
 *    offending rows are dropped, with an error log, so one poison row cannot block the queue forever.
 *  - Queue full (DB down for a long time): the OLDEST entries are dropped and counted (stats().dropped / onDrop metric).
 *  - Shutdown: close() flushes with a deadline; anything still unwritten is emitted to the application log as JSON.
 * Tradeoff: the queue lives in process memory, so a hard crash can lose up to flushIntervalMs of entries. A durable
 * alternative (Redis stream / outbox table) costs latency and complexity this project deliberately avoids.
 */
export class RequestLogger {
  private queue: RequestLogEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private failures = 0;
  private nextAttemptAt = 0;
  private droppedTotal = 0;
  private writtenTotal = 0;
  private closed = false;
  private readonly now: () => number;

  constructor(private readonly pool: Pick<Pool, 'query'>, private readonly o: RequestLoggerOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flush(); }, this.o.flushIntervalMs);
    this.timer.unref();
  }

  stats(): { queued: number; dropped: number; written: number; consecutiveFailures: number } {
    return { queued: this.queue.length, dropped: this.droppedTotal, written: this.writtenTotal, consecutiveFailures: this.failures };
  }

  enqueue(entry: RequestLogEntry): void {
    if (this.closed) { this.o.log?.warn({ entry: { requestId: entry.requestId } }, 'request log after shutdown; dropped'); this.drop(1); return; }
    this.trimTo(this.o.maxQueue - 1);
    this.queue.push(entry);
    if (this.queue.length >= this.o.batchSize && this.now() >= this.nextAttemptAt) void this.flush();
  }

  private drop(n: number): void {
    if (n <= 0) return;
    this.droppedTotal += n;
    this.o.onDrop?.(n);
  }

  private trimTo(max: number): void {
    const excess = this.queue.length - max;
    if (excess > 0) {
      this.queue.splice(0, excess); // drop oldest
      this.drop(excess);
      this.o.log?.warn({ dropped: excess }, 'request log queue full; oldest entries dropped');
    }
  }

  /** Flushes queued entries. Honours backoff unless `force` (used at shutdown). */
  flush(force = false): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!force && this.now() < this.nextAttemptAt) return Promise.resolve();
    this.flushing = this.drain().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.o.batchSize);
      try {
        await this.insert(batch);
        this.writtenTotal += batch.length;
        this.failures = 0;
        this.nextAttemptAt = 0;
      } catch (err) {
        const code = (err as { code?: string }).code ?? '';
        if (code.startsWith('22') || code.startsWith('23')) {
          await this.insertIndividually(batch);
          continue;
        }
        this.queue.unshift(...batch);
        this.trimTo(this.o.maxQueue);
        this.failures++;
        this.nextAttemptAt = this.now() + Math.min(30_000, 1000 * 2 ** (this.failures - 1));
        this.o.log?.error({ err: (err as Error).message, queued: this.queue.length, failures: this.failures }, 'request log flush failed; will retry');
        return;
      }
    }
  }

  private async insertIndividually(batch: RequestLogEntry[]): Promise<void> {
    for (const e of batch) {
      try {
        await this.insert([e]);
        this.writtenTotal++;
      } catch (err) {
        const code = (err as { code?: string }).code ?? '';
        if (code.startsWith('22') || code.startsWith('23')) {
          this.drop(1);
          this.o.log?.error({ requestId: e.requestId, err: (err as Error).message }, 'request log row rejected by database; dropped');
        } else {
          this.queue.unshift(e); // transient error mid-way: keep it for the normal retry path
          throw err;
        }
      }
    }
  }

  private async insert(batch: RequestLogEntry[]): Promise<void> {
    const params: unknown[] = [];
    const rows = batch.map((e, i) => {
      params.push(...values(e));
      const base = i * COLUMNS.length;
      return `(${COLUMNS.map((_, j) => `$${base + j + 1}`).join(',')})`;
    });
    await this.pool.query(`INSERT INTO request_logs (${COLUMNS.join(',')}) VALUES ${rows.join(',')}`, params);
  }

  /** Stops the timer and flushes within `deadlineMs`. Returns the number of entries that could not be written (also logged). */
  async close(deadlineMs = 5000): Promise<number> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    const deadline = this.now() + deadlineMs;
      while (this.queue.length > 0 && this.now() < deadline)
      {
        let deadlineTimer: NodeJS.Timeout | undefined;
        const timedOut = new Promise<void>((r) => { deadlineTimer = setTimeout(r, Math.max(1, deadline - this.now())); });
        try 
        {
             await Promise.race([this.flush(true), timedOut]);
        } 
        finally 
        {
          clearTimeout(deadlineTimer); // never leave a pending timer behind
        }
        if (this.failures > 0) break;
      }
    const left = this.queue.splice(0);
    for (const e of left) this.o.log?.error({ unflushedRequestLog: e }, 'request log not persisted at shutdown');
    return left.length;
  }
}
