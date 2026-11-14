import { extractBearer, generateApiKey, hashApiKey, parseKeyPrefix, verifyApiKey } from '../../packages/auth/src/apiKey';

const PEPPER = 'p'.repeat(40);

describe('api key security', () => {
  it('generates keys in the documented format and stores only prefix + hash', () => {
    const k = generateApiKey(PEPPER);
    expect(k.plaintext).toMatch(/^lgw_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    expect(parseKeyPrefix(k.plaintext)).toBe(k.prefix);
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(k.hash).not.toContain(k.plaintext);
  });
  it('generates unique keys', () => {
    expect(generateApiKey(PEPPER).plaintext).not.toBe(generateApiKey(PEPPER).plaintext);
  });
  it('verifies the right key and rejects a wrong key or wrong pepper', () => {
    const k = generateApiKey(PEPPER);
    expect(verifyApiKey(k.plaintext, k.hash, PEPPER)).toBe(true);
    expect(verifyApiKey(k.plaintext + 'x', k.hash, PEPPER)).toBe(false);
    expect(verifyApiKey(k.plaintext, k.hash, 'q'.repeat(40))).toBe(false);
  });
  it('hash depends on the pepper', () => {
    expect(hashApiKey('abc', 'a'.repeat(32))).not.toBe(hashApiKey('abc', 'b'.repeat(32)));
  });
  it('rejects malformed keys without throwing', () => {
    for (const bad of ['', 'lgw_', 'lgw_zzzzzzzz_' + 'a'.repeat(43), 'sk-123', 'lgw_0123abcd_short']) {
      expect(parseKeyPrefix(bad)).toBeNull();
    }
  });
  it('parses Bearer headers strictly', () => {
    expect(extractBearer('Bearer abc')).toBe('abc');
    expect(extractBearer('bearer abc')).toBe('abc');
    expect(extractBearer('Basic abc')).toBeNull();
    expect(extractBearer('Bearer')).toBeNull();
    expect(extractBearer(undefined)).toBeNull();
  });
});
