#!/usr/bin/env node
/**
 * Creates .env from .env.example with freshly generated random secrets. Refuses to overwrite an existing .env.
 *   node scripts/gen-env.js           (or: npm run setup)
 * Secrets are written only to .env (git-ignored). Nothing is printed except the file path.
 */
const { randomBytes } = require('node:crypto');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const target = join(root, '.env');
if (existsSync(target)) {
  console.error('.env already exists; not overwriting. Delete it first if you want new secrets (this invalidates existing API keys).');
  process.exit(1);
}
const secret = () => randomBytes(32).toString('hex');
let out = readFileSync(join(root, '.env.example'), 'utf8')
  .replace(/^API_KEY_PEPPER=.*$/m, () => `API_KEY_PEPPER=${secret()}`)
  .replace(/^ADMIN_API_TOKEN=.*$/m, () => `ADMIN_API_TOKEN=${secret()}`);
if (/REPLACE_ME/.test(out)) { console.error('Unreplaced placeholder left in .env.example; aborting.'); process.exit(1); }
writeFileSync(target, out, { flag: 'wx', mode: 0o600 });
console.log('Wrote .env with new API_KEY_PEPPER and ADMIN_API_TOKEN (use ADMIN_API_TOKEN to sign in to the dashboard).');
