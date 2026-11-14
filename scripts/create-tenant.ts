import 'dotenv/config';
import { ApiKeyRepository } from '../packages/auth/src/repository';
import { loadConfig } from '../packages/config/src';
import { createPool } from '../packages/database/src/pool';

/** Usage: npm run create-tenant -- <name> [monthlyTokenBudget]. Prints the API key ONCE. */
async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) throw new Error('usage: npm run create-tenant -- <name> [monthlyTokenBudget]');
  const cfg = loadConfig();
  const budget = process.argv[3] ? Number(process.argv[3]) : cfg.DEFAULT_MONTHLY_TOKEN_BUDGET;
  if (!Number.isInteger(budget) || budget < 0) throw new Error('budget must be a non-negative integer');
  const pool = createPool(cfg.DATABASE_URL);
  try {
    const repo = new ApiKeyRepository(pool, cfg.API_KEY_PEPPER);
    const tenantId = await repo.createTenant(name, budget);
    const key = await repo.createKey(tenantId, 'bootstrap');
    console.log(`tenant_id: ${tenantId}\napi_key:   ${key.plaintext}\n(store this key now; it cannot be shown again)`);
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
