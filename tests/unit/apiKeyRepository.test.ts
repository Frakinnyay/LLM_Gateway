import { ApiKeyRepository } from '../../packages/auth/src/repository';

const PEPPER = 'p'.repeat(40);

interface Row { id: string; tenant_id: string; key_prefix: string; key_hash: string; status: string }

/** In-memory stand-in for the three queries the repository issues. */
function fakePool(opts: { collisions?: number; tenantStatus?: string } = {}) {
  const rows: Row[] = []; let collisions = opts.collisions ?? 0; let touches = 0; let inserts = 0;
  const pool = {
    async query(sql: string, params: unknown[]) {
      if (sql.startsWith('INSERT INTO api_keys')) {
        inserts++;
        if (collisions > 0) { collisions--; throw Object.assign(new Error('duplicate key'), { code: '23505' }); }
        const row: Row = { id: `id-${rows.length + 1}`, tenant_id: String(params[0]), key_prefix: String(params[1]), key_hash: String(params[2]), status: 'active' };
        rows.push(row); return { rows: [{ id: row.id }], rowCount: 1 };
      }
      if (sql.includes('FROM api_keys k JOIN tenants')) {
        const r = rows.find((x) => x.key_prefix === params[0]);
        return { rows: r ? [{ id: r.id, key_hash: r.key_hash, key_status: r.status, tenant_id: r.tenant_id, name: 't', tenant_status: opts.tenantStatus ?? 'active', monthly_token_budget: '1000' }] : [] };
      }
      if (sql.startsWith('UPDATE api_keys SET last_used_at')) { touches++; return { rows: [], rowCount: 1 }; }
      throw new Error('unexpected SQL: ' + sql);
    },
  };
  return { pool, rows, touches: () => touches, inserts: () => inserts };
}

describe('ApiKeyRepository', () => {
  it('retries with a fresh key when the public prefix collides, and returns a working key', async () => {
    const f = fakePool({ collisions: 2 });
    const repo = new ApiKeyRepository(f.pool as never, PEPPER);
    const k = await repo.createKey('tenant-1');
    expect(f.inserts()).toBe(3);
    expect(await repo.authenticate(k.plaintext)).toMatchObject({ tenantId: 'tenant-1', apiKeyId: k.id, monthlyTokenBudget: 1000 });
  });
  it('gives up after 5 collisions instead of looping forever', async () => {
    const f = fakePool({ collisions: 99 });
    await expect(new ApiKeyRepository(f.pool as never, PEPPER).createKey('t')).rejects.toMatchObject({ code: '23505' });
    expect(f.inserts()).toBe(5);
  });
  it('does not retry other database errors', async () => {
    const pool = { query: async () => { throw Object.assign(new Error('fk'), { code: '23503' }); } };
    await expect(new ApiKeyRepository(pool as never, PEPPER).createKey('t')).rejects.toMatchObject({ code: '23503' });
  });
  it('stores a hash, never the plaintext', async () => {
    const f = fakePool(); const k = await new ApiKeyRepository(f.pool as never, PEPPER).createKey('t');
    expect(f.rows[0]?.key_hash).not.toContain(k.plaintext);
    expect(f.rows[0]?.key_hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects wrong secrets, revoked keys and suspended tenants with null', async () => {
    const f = fakePool(); const repo = new ApiKeyRepository(f.pool as never, PEPPER); const k = await repo.createKey('t');
    expect(await repo.authenticate(k.plaintext.slice(0, -1) + 'x')).toBeNull();
    f.rows[0]!.status = 'revoked';
    expect(await repo.authenticate(k.plaintext)).toBeNull();
    const s = fakePool({ tenantStatus: 'suspended' }); const r2 = new ApiKeyRepository(s.pool as never, PEPPER);
    expect(await r2.authenticate((await r2.createKey('t')).plaintext)).toBeNull();
    expect(await repo.authenticate('garbage')).toBeNull();
  });
  it('throttles last_used_at writes to once per minute per key', async () => {
    const clock = { t: 1_000_000 };
    const f = fakePool(); const repo = new ApiKeyRepository(f.pool as never, PEPPER, () => clock.t);
    const k = await repo.createKey('t');
    for (let i = 0; i < 50; i++) await repo.authenticate(k.plaintext);
    expect(f.touches()).toBe(1); // 50 authentications, one write
    clock.t += 59_000; await repo.authenticate(k.plaintext);
    expect(f.touches()).toBe(1);
    clock.t += 2_000; await repo.authenticate(k.plaintext);
    expect(f.touches()).toBe(2);
  });
});
