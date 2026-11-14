import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const KEY_TAG = 'lgw';
export interface GeneratedKey {
  plaintext: string; // show to the user ONCE, never store
  prefix: string; // public lookup id, stored
  hash: string; // HMAC-SHA256 hex, stored
}

/**
 * Key format: lgw_<8 hex prefix>_<43 char base64url secret (256 bits)>.
 * Keys are high-entropy random values, so a fast keyed hash (HMAC-SHA256 with a
 * server-side pepper) is appropriate; slow password hashes (bcrypt/argon2) add
 * latency to every request without adding security for 256-bit secrets.
 */
export function generateApiKey(pepper: string): GeneratedKey {
  const prefix = randomBytes(4).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const plaintext = `${KEY_TAG}_${prefix}_${secret}`;
  return { plaintext, prefix, hash: hashApiKey(plaintext, pepper) };
}

export function hashApiKey(plaintext: string, pepper: string): string {
  return createHmac('sha256', pepper).update(plaintext).digest('hex');
}

/** Extracts the lookup prefix from a presented key; null if malformed. */
export function parseKeyPrefix(presented: string): string | null {
  const m = /^lgw_([0-9a-f]{8})_[A-Za-z0-9_-]{43}$/.exec(presented);
  return m ? (m[1] as string) : null;
}

export function verifyApiKey(presented: string, storedHash: string, pepper: string): boolean {
  const a = Buffer.from(hashApiKey(presented, pepper), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m ? (m[1] as string) : null;
}
