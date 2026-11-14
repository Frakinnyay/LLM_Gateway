import { loadConfig } from '../../packages/config/src';

const ok = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db', REDIS_URL: 'redis://localhost:6379',
  API_KEY_PEPPER: 'a'.repeat(40), ADMIN_API_TOKEN: 'b'.repeat(40), MOCK_PROVIDER_ENABLED: 'true',
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('accepts a minimal valid mock-only configuration and applies defaults', () => {
    const c = loadConfig(ok);
    expect(c.PORT).toBe(8080);
    expect(c.SEMANTIC_CACHE_THRESHOLD).toBe(0.92);
    expect(c.PROVIDER_PRIORITY).toEqual(['mock', 'groq', 'gemini', 'openrouter']);
    expect(c.RATE_LIMIT_FAIL_OPEN).toBe(true);
  });
  it('fails clearly when required settings are missing', () => {
    expect(() => loadConfig({ ...ok, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...ok, API_KEY_PEPPER: 'short' })).toThrow(/API_KEY_PEPPER/);
  });
  it('requires a key for every enabled real provider', () => {
    expect(() => loadConfig({ ...ok, GROQ_ENABLED: 'true' })).toThrow(/GROQ_API_KEY/);
  });
  it('requires at least one enabled provider', () => {
    expect(() => loadConfig({ ...ok, MOCK_PROVIDER_ENABLED: 'false' })).toThrow(/At least one provider/);
  });
  it('rejects placeholder secrets in production but allows them in development', () => {
    const placeholder = { ...ok, API_KEY_PEPPER: 'REPLACE_ME_' + 'x'.repeat(30) };
    expect(() => loadConfig({ ...placeholder, NODE_ENV: 'production' })).toThrow(/placeholder/);
    expect(() => loadConfig({ ...placeholder, NODE_ENV: 'development' })).not.toThrow();
  });
  it('rejects out-of-range values', () => {
    expect(() => loadConfig({ ...ok, SEMANTIC_CACHE_THRESHOLD: '1.5' })).toThrow(/SEMANTIC_CACHE_THRESHOLD/);
  });
});
