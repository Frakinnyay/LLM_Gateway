import 'dotenv/config'; // picks up POSTGRES_PORT / REDIS_PORT from .env when set
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Express } from 'express';
import Redis from 'ioredis';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../apps/gateway/src/app';
import { buildDeps } from '../../apps/gateway/src/bootstrap';
import type { Deps } from '../../apps/gateway/src/types';
import { loadConfig } from '../../packages/config/src';
import { runMigrations } from '../../packages/database/src/migrate';
import { MockProvider } from '../../packages/providers/src/mockProvider';
import { createLogger } from '../../packages/shared/src/logger';

/**
 * Integration environment. REQUIRES PostgreSQL with pgvector and Redis (e.g. `docker compose up -d postgres redis`).
 * Isolation: each env gets its own Postgres SCHEMA (search_path) and Redis DB 15 (flushed), so suites never touch dev data.
 * Run with --runInBand (the npm script does) because Redis DB 15 is shared by all suites.
 */
export const DB_URL = process.env.TEST_DATABASE_URL ?? `postgres://gateway:gateway@localhost:${process.env.POSTGRES_PORT ?? '5432'}/llm_gateway`;
export const REDIS_URL = process.env.TEST_REDIS_URL ?? `redis://localhost:${process.env.REDIS_PORT ?? '6379'}/15`;
export const ADMIN_TOKEN = 'test-admin-token-' + 'y'.repeat(32);
export const ADMIN = { Authorization: `Bearer ${ADMIN_TOKEN}` };

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test', LOG_LEVEL: 'fatal',
  API_KEY_PEPPER: 'test-pepper-' + 'x'.repeat(32), ADMIN_API_TOKEN: ADMIN_TOKEN,
  MOCK_PROVIDER_ENABLED: 'true', MOCK_PROVIDER_INSTANCES: '2', MOCK_PROVIDER_LATENCY_MS: '0',
  RATE_LIMIT_CAPACITY: '1000', RATE_LIMIT_REFILL_PER_SEC: '1000',
  SEMANTIC_CACHE_ENABLED: 'false', PROVIDER_MAX_RETRIES: '0', PROVIDER_TIMEOUT_MS: '300',
  CB_FAILURE_THRESHOLD: '3', CB_COOLDOWN_MS: '200', DEFAULT_MONTHLY_TOKEN_BUDGET: '10000000',
};

export interface TestEnv {
  app: Express;
  server: Server;
  deps: Deps;
  pool: Pool;
  redis: Redis;
  port: number;
  http(): ReturnType<typeof request>;
  createTenant(opts?: { budget?: number; name?: string }): Promise<{ tenantId: string; apiKey: string; keyId: string }>;
  chat(apiKey: string, body?: object, headers?: Record<string, string>): request.Test;
  mock(name?: string): MockProvider;
  flushLogs(): Promise<void>;
  close(): Promise<void>;
}

export async function createTestEnv(overrides: Record<string, string> = {}): Promise<TestEnv> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: DB_URL, max: 1 });
  // Extensions live in `public` so every test schema can use them (and dropping a schema never drops them).
  await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
  await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: DB_URL, options: `-c search_path=${schema},public`, max: 10 });
  await runMigrations(pool, join(process.cwd(), 'migrations'));

  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
  await redis.flushdb();

  const cfg = loadConfig({ ...BASE_ENV, DATABASE_URL: DB_URL, REDIS_URL, ...overrides } as NodeJS.ProcessEnv);
  const deps = await buildDeps(cfg, pool, redis, createLogger('fatal'));
  const app = createApp(deps);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;

  const env: TestEnv = {
    app, server, deps, pool, redis, port,
    http: () => request(server),
    async createTenant(opts = {}) {
      const tenantId = await deps.apiKeys.createTenant(opts.name ?? `tenant-${randomBytes(4).toString('hex')}`, opts.budget ?? 10_000_000);
      const k = await deps.apiKeys.createKey(tenantId, 'test');
      return { tenantId, apiKey: k.plaintext, keyId: k.id };
    },
    chat: (apiKey, body = uniqueBody(), headers = {}) =>
      request(server).post('/v1/chat/completions').set('Authorization', `Bearer ${apiKey}`).set(headers).send(body),
    mock: (name = 'mock') => deps.providers.getProvider(name) as MockProvider,
    flushLogs: () => deps.requestLogger.flush(true),
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await deps.requestLogger.close(1000).catch(() => undefined);
      await pool.end().catch(() => undefined); // a test may already have ended the pool on purpose (simulated DB outage)
      redis.disconnect();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
  return env;
}

let counter = 0;
/** A request body whose prompt is unique, so it cannot hit any cache. */
export function uniqueBody(extra: Record<string, unknown> = {}, content?: string): Record<string, unknown> {
  return { model: 'mock-model', messages: [{ role: 'user', content: content ?? `unique prompt ${Date.now()}-${++counter}` }], ...extra };
}

export const parseSSE = (text: string): string[] =>
  text.split('\n\n').map((e) => e.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')).filter(Boolean);

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await check()) return true; await sleep(25); }
  return false;
}
