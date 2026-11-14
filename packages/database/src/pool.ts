import { Pool } from 'pg';

export function createPool(databaseUrl: string): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // Without a listener an idle-client error would crash the process.
  pool.on('error', (err) => console.error('pg pool idle client error:', err.message));
  return pool;
}
