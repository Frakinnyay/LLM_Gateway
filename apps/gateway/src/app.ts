import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { adminRouter } from './routes/admin';
import { observe } from './middleware/observe';
import { observabilityRouter } from './routes/observability';
import { providersRouter } from './routes/providers';
import { chatRouter } from './routes/chat';
import { asyncHandler, errorHandler, notFound, requestId, requireAdmin, requireApiKey } from './middleware/common';
import type { Deps } from './types';

/** Builds the Express app from injected dependencies (also used by Supertest). */
export function createApp(deps: Deps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(observe(deps));
  app.use(helmet());
  // Empty allowlist => origin:false => no CORS headers at all.
  app.use(cors({ origin: deps.cfg.CORS_ORIGINS.length ? deps.cfg.CORS_ORIGINS : false }));

  // Liveness: process is up. Independent of dependencies and providers.
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });

  // Readiness: required dependencies only (Postgres + Redis).
  app.get('/ready', async (_req, res) => {
    const checks = { postgres: false, redis: false };
    await Promise.all([
      deps.pool.query('SELECT 1').then(() => { checks.postgres = true; }).catch(() => undefined),
      deps.redis.ping().then(() => { checks.redis = true; }).catch(() => undefined),
    ]);
    const ready = checks.postgres && checks.redis;
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
  });

  // Prometheus scrape endpoint. Labels are bounded (see packages/metrics). Set METRICS_REQUIRE_AUTH=true to require the admin token.
  const metricsGuards = deps.cfg.METRICS_REQUIRE_AUTH ? [requireAdmin(deps)] : [];
  app.get('/metrics', ...metricsGuards, asyncHandler(async (_req, res) => {
    res.setHeader('Content-Type', deps.metrics.registry.contentType);
    res.end(await deps.metrics.registry.metrics());
  }));

  // Auth runs BEFORE body parsing so unauthenticated callers cannot make us buffer bodies.
  const json = express.json({ limit: deps.cfg.REQUEST_BODY_LIMIT });
  app.use('/v1', requireApiKey(deps), json, chatRouter(deps));
  app.use('/api', requireAdmin(deps), json, adminRouter(deps), providersRouter(deps), observabilityRouter(deps));

  app.use(notFound());
  app.use(errorHandler(deps));
  return app;
}
