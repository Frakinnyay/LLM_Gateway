import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../../../packages/shared/src/errors';
import { asyncHandler } from '../middleware/common';
import { parseOrThrow } from '../schemas';
import type { Deps } from '../types';

const uuid = z.string().uuid();
const tenantBody = z.object({ name: z.string().min(1).max(100), monthly_token_budget: z.number().int().min(0).optional() });
const keyBody = z.object({ tenant_id: uuid, label: z.string().max(100).optional() });
const keyQuery = z.object({ tenant_id: uuid });

/** Admin API. Caller must already have passed requireAdmin. Secrets are never returned except the one-time plaintext at key creation. */
export function adminRouter(deps: Deps): Router {
  const r = Router();

  r.post('/tenants', asyncHandler(async (req, res) => {
    const b = parseOrThrow(tenantBody, req.body);
    try {
      const id = await deps.apiKeys.createTenant(b.name, b.monthly_token_budget ?? deps.cfg.DEFAULT_MONTHLY_TOKEN_BUDGET);
      res.status(201).json({ id, name: b.name });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AppError(409, 'invalid_request_error', 'TENANT_EXISTS', 'Tenant name already exists');
      throw e;
    }
  }));

  r.post('/keys', asyncHandler(async (req, res) => {
    const b = parseOrThrow(keyBody, req.body);
    try {
      const k = await deps.apiKeys.createKey(b.tenant_id, b.label);
      res.status(201).json({ id: k.id, prefix: k.prefix, api_key: k.plaintext, note: 'Store this key now; it cannot be retrieved again.' });
    } catch (e) {
      if ((e as { code?: string }).code === '23503') throw new AppError(404, 'invalid_request_error', 'TENANT_NOT_FOUND', 'Tenant not found');
      throw e;
    }
  }));

  r.get('/keys', asyncHandler(async (req, res) => {
    const q = parseOrThrow(keyQuery, req.query);
    res.json({ data: await deps.apiKeys.listKeys(q.tenant_id) });
  }));

  r.delete('/keys/:id', asyncHandler(async (req, res) => {
    const id = parseOrThrow(uuid, req.params.id);
    const ok = await deps.apiKeys.revokeKeyById(id);
    if (!ok) throw new AppError(404, 'invalid_request_error', 'KEY_NOT_FOUND', 'Active key not found');
    res.status(204).end();
  }));

  return r;
}
