import { buildCacheKey } from '../../packages/cache/src/exactCache';
import type { ChatRequest } from '../../packages/providers/src/types';

const base: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'hello' }], temperature: 0.2 };

describe('exact cache key', () => {
  it('is deterministic and namespaced/versioned', () => {
    expect(buildCacheKey('t1', base)).toBe(buildCacheKey('t1', { ...base }));
    expect(buildCacheKey('t1', base)).toMatch(/^llmgw:v1:cache:[0-9a-f]{64}$/);
  });
  it.each([
    ['model', { model: 'other' }],
    ['temperature', { temperature: 0.9 }],
    ['top_p', { top_p: 0.5 }],
    ['max_tokens', { max_tokens: 10 }],
    ['stop', { stop: ['x'] }],
    ['message content', { messages: [{ role: 'user' as const, content: 'hello!' }] }],
    ['message role', { messages: [{ role: 'system' as const, content: 'hello' }] }],
  ])('changes when %s changes (no cross-parameter cache hits)', (_name, change) => {
    expect(buildCacheKey('t1', { ...base, ...change })).not.toBe(buildCacheKey('t1', base));
  });
  it('separates tenants', () => {
    expect(buildCacheKey('t1', base)).not.toBe(buildCacheKey('t2', base));
  });
  it('distinguishes an unset parameter from an explicit value', () => {
    const { temperature: _t, ...noTemp } = base;
    expect(buildCacheKey('t1', noTemp)).not.toBe(buildCacheKey('t1', { ...base, temperature: 0 }));
  });
  it('treats stop-sequence order as irrelevant', () => {
    expect(buildCacheKey('t', { ...base, stop: ['a', 'b'] })).toBe(buildCacheKey('t', { ...base, stop: ['b', 'a'] }));
  });
  it('is not fooled by message-boundary shifting', () => {
    const a = buildCacheKey('t', { model: 'm', messages: [{ role: 'user', content: 'ab' }, { role: 'user', content: 'c' }] });
    const b = buildCacheKey('t', { model: 'm', messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'bc' }] });
    expect(a).not.toBe(b);
  });
});
