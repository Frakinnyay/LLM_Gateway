import { cosineSimilarity, HashingEmbeddingProvider } from '../../packages/cache/src/embedding';
import { buildSemanticInput } from '../../packages/cache/src/semanticCache';
import type { ChatRequest } from '../../packages/providers/src/types';

describe('HashingEmbeddingProvider', () => {
  const e = new HashingEmbeddingProvider();
  it('returns deterministic, unit-length, 384-d vectors', async () => {
    const v = await e.embed('Explain vector databases.');
    expect(v).toHaveLength(384);
    expect(v).toEqual(await e.embed('Explain vector databases.'));
    expect(Math.sqrt(v.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
  });
  it('scores identical text 1 and unrelated text near 0', async () => {
    expect(cosineSimilarity(await e.embed('vector databases'), await e.embed('vector databases'))).toBeCloseTo(1, 6);
    expect(cosineSimilarity(await e.embed('Explain vector databases.'), await e.embed('Write a haiku about autumn.'))).toBeLessThan(0.2);
  });
  it('never returns a zero vector (punctuation-only input)', async () => {
    const v = await e.embed('?!?!');
    expect(v.some((x) => x !== 0)).toBe(true);
  });
});

describe('buildSemanticInput (cache scoping)', () => {
  const req: ChatRequest = { model: 'm', temperature: 0.2, messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'What is Redis?' }] };
  it('embeds only the final user message', () => {
    expect(buildSemanticInput(req)?.text).toBe('What is Redis?');
  });
  it('skips requests that do not end in a user message', () => {
    expect(buildSemanticInput({ ...req, messages: [...req.messages, { role: 'assistant', content: 'x' }] })).toBeNull();
  });
  it('keeps the same context hash when only the last user message differs', () => {
    const other = { ...req, messages: [req.messages[0]!, { role: 'user' as const, content: 'Tell me about Redis' }] };
    expect(buildSemanticInput(other)?.contextHash).toBe(buildSemanticInput(req)?.contextHash);
  });
  it.each([
    ['model', { model: 'other' }],
    ['temperature', { temperature: 1 }],
    ['max_tokens', { max_tokens: 5 }],
    ['system prompt', { messages: [{ role: 'system' as const, content: 'be verbose' }, { role: 'user' as const, content: 'What is Redis?' }] }],
  ])('changes the context hash when %s changes (no cross-context semantic hits)', (_n, change) => {
    expect(buildSemanticInput({ ...req, ...change })?.contextHash).not.toBe(buildSemanticInput(req)?.contextHash);
  });
});
