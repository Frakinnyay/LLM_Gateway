import 'dotenv/config';
import { resolve } from 'node:path';
import { loadConfig } from '../packages/config/src';
import { createPool } from '../packages/database/src/pool';
import { runMigrations } from '../packages/database/src/migrate';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const pool = createPool(cfg.DATABASE_URL);
  try {
    // Resolved from the working directory: the repo root in development, /app in the container image.
    const applied = await runMigrations(pool, resolve(process.cwd(), 'migrations'));
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations');
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
