import 'dotenv/config';
import { loadConfig } from '../../../packages/config/src';
import { createPool } from '../../../packages/database/src/pool';
import { createRedis } from '../../../packages/redis/src/client';
import { createLogger } from '../../../packages/shared/src/logger';
import { createApp } from './app';
import { buildDeps } from './bootstrap';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL);
  const pool = createPool(cfg.DATABASE_URL);
  const redis = createRedis(cfg.REDIS_URL);
  const deps = await buildDeps(cfg, pool, redis, log);

  deps.requestLogger.start();
  const purgeTimer = setInterval(() => {
    deps.semanticCache.purgeExpired().catch((e) => log.warn({ err: (e as Error).message }, 'semantic cache purge failed'));
  }, 3_600_000);
  purgeTimer.unref();

  const server = createApp(deps).listen(cfg.PORT, () =>
    log.info({ port: cfg.PORT, providers: deps.providers.status().map((p) => p.name) }, 'gateway listening'));

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    clearInterval(purgeTimer);
    setTimeout(() => process.exit(1), 10_000).unref();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose())); // waits for in-flight requests
    const unflushed = await deps.requestLogger.close(5000); // flush queued request logs BEFORE closing the pool
    if (unflushed > 0) log.error({ unflushed }, 'request logs lost at shutdown');
    await pool.end().catch(() => undefined);
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
