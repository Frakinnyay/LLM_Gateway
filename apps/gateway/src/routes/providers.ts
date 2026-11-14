import { Router } from 'express';
import { z } from 'zod';
import { MockProvider } from '../../../../packages/providers/src/mockProvider';
import { AppError } from '../../../../packages/shared/src/errors';
import { asyncHandler } from '../middleware/common';
import { parseOrThrow } from '../schemas';
import type { Deps } from '../types';

const failureBody = z.object({ mode: z.enum(['none', 'http_500', 'http_503', 'timeout', 'bad_request', 'stream_cut']) });

/** Admin provider controls (mounted under /api behind requireAdmin): status, enable/disable, mock chaos mode. */
export function providersRouter(deps: Deps): Router {
  const r = Router();

  const known = (name: string | undefined): string => {
    if (!name || !deps.providers.has(name)) throw new AppError(404, 'invalid_request_error', 'PROVIDER_NOT_FOUND', 'Unknown provider');
    return name;
  };
  const audit = (action: string, target: string, metadata: Record<string, unknown>) =>
    deps.pool.query('INSERT INTO audit_logs(actor, action, target_type, target_id, metadata) VALUES ($1,$2,$3,$4,$5::jsonb)',
      ['admin', action, 'provider', target, JSON.stringify(metadata)])
      .catch((e) => deps.log.warn({ err: (e as Error).message }, 'audit log write failed'));

  r.get('/providers', (_req, res) => { res.json({ data: deps.providers.status() }); });

  for (const action of ['enable', 'disable'] as const) {
    r.post(`/providers/:provider/${action}`, asyncHandler(async (req, res) => {
      const name = known(req.params.provider);
      const enabled = action === 'enable';
      deps.providers.setEnabled(name, enabled);
      // Persist so the choice survives a restart (loaded at startup).
      await deps.pool.query(
        `INSERT INTO provider_configs(provider, enabled, updated_by) VALUES ($1,$2,'admin')
         ON CONFLICT (provider) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now(), updated_by = 'admin'`,
        [name, enabled]);
      await audit(`provider.${action}`, name, {});
      res.json({ provider: name, enabled });
    }));
  }

  // Chaos control for demos: only meaningful for mock providers.
  r.post('/providers/:provider/failure-mode', asyncHandler(async (req, res) => {
    const name = known(req.params.provider);
    const p = deps.providers.getProvider(name);
    if (!(p instanceof MockProvider)) throw new AppError(400, 'invalid_request_error', 'NOT_A_MOCK_PROVIDER', 'Failure modes apply to mock providers only');
    const { mode } = parseOrThrow(failureBody, req.body);
    p.setFailureMode(mode);
    await audit('provider.failure_mode', name, { mode });
    res.json({ provider: name, mode });
  }));

  return r;
}
