import type { Pool } from 'pg';
import { generateApiKey, parseKeyPrefix, verifyApiKey } from './apiKey';

export interface AuthContext {
  tenantId: string;
  apiKeyId: string;
  tenantName: string;
  monthlyTokenBudget: number;
}

export interface ApiKeyMetadata {
  id: string;
  tenantId: string;
  prefix: string;
  label: string | null;
  status: 'active' | 'revoked';
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** last_used_at is only refreshed this often per key: a write on every request would create a hot row under load. */
const TOUCH_INTERVAL_MS = 60_000;
const MAX_TRACKED_KEYS = 10_000;
const KEY_CREATE_ATTEMPTS = 5;

export class ApiKeyRepository {
  private readonly lastTouch = new Map<string, number>();

  constructor(private readonly pool: Pool, private readonly pepper: string, private readonly now: () => number = Date.now) {}

  async createTenant(name: string, monthlyTokenBudget: number): Promise<string> {
    const r = await this.pool.query<{ id: string }>(
      'INSERT INTO tenants(name, monthly_token_budget) VALUES ($1,$2) RETURNING id',
      [name, monthlyTokenBudget],
    );
    return (r.rows[0] as { id: string }).id;
  }

  /**
   * Returns plaintext exactly once; only prefix+hash are persisted. The 32-bit public prefix is unique-constrained, so a
   * (rare) collision is retried with a fresh key instead of surfacing as a server error.
   */
  async createKey(tenantId: string, label?: string): Promise<{ id: string; plaintext: string; prefix: string }> {
    for (let attempt = 1; ; attempt++) {
      const k = generateApiKey(this.pepper);
      try {
        const r = await this.pool.query<{ id: string }>(
          'INSERT INTO api_keys(tenant_id, key_prefix, key_hash, label) VALUES ($1,$2,$3,$4) RETURNING id',
          [tenantId, k.prefix, k.hash, label ?? null],
        );
        return { id: (r.rows[0] as { id: string }).id, plaintext: k.plaintext, prefix: k.prefix };
      } catch (err) {
        if ((err as { code?: string }).code === '23505' && attempt < KEY_CREATE_ATTEMPTS) continue;
        throw err;
      }
    }
  }

  async listKeys(tenantId: string): Promise<ApiKeyMetadata[]> {
    const r = await this.pool.query(
      `SELECT id, tenant_id, key_prefix, label, status, created_at, last_used_at
         FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return r.rows.map((x) => ({
      id: x.id, tenantId: x.tenant_id, prefix: x.key_prefix, label: x.label,
      status: x.status, createdAt: x.created_at, lastUsedAt: x.last_used_at,
    }));
  }

  /** Admin revocation by key id (the admin token already authorises cross-tenant access). */
  async revokeKeyById(keyId: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE api_keys SET status='revoked', revoked_at=now() WHERE id=$1 AND status='active'`,
      [keyId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async revokeKey(tenantId: string, keyId: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE api_keys SET status='revoked', revoked_at=now()
        WHERE id=$1 AND tenant_id=$2 AND status='active'`,
      [keyId, tenantId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Authenticates a presented key. Returns null for any failure (no reason leaked). */
  async authenticate(presented: string): Promise<AuthContext | null> {
    const prefix = parseKeyPrefix(presented);
    if (!prefix) return null;
    const r = await this.pool.query(
      `SELECT k.id, k.key_hash, k.status AS key_status, t.id AS tenant_id, t.name,
              t.status AS tenant_status, t.monthly_token_budget
         FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
        WHERE k.key_prefix = $1`,
      [prefix],
    );
    const row = r.rows[0];
    if (!row) return null;
    const ok = verifyApiKey(presented, row.key_hash, this.pepper);
    if (!ok || row.key_status !== 'active' || row.tenant_status !== 'active') return null;
    // Best-effort bookkeeping, throttled per key; must never fail or slow authentication.
    const t = this.now();
    if (t - (this.lastTouch.get(row.id) ?? 0) >= TOUCH_INTERVAL_MS) {
      if (this.lastTouch.size >= MAX_TRACKED_KEYS) this.lastTouch.clear();
      this.lastTouch.set(row.id, t);
      void this.pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => undefined);
    }
    return {
      tenantId: row.tenant_id, apiKeyId: row.id, tenantName: row.name,
      monthlyTokenBudget: Number(row.monthly_token_budget),
    };
  }
}
