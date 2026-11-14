import { AppError } from '../../packages/shared/src/errors';
import { chatRequestSchema, parseOrThrow } from '../../apps/gateway/src/schemas';

const valid = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

describe('chat request validation', () => {
  it('accepts a minimal request and defaults stream to false', () => {
    expect(parseOrThrow(chatRequestSchema, valid).stream).toBe(false);
  });
  it('normalises a string stop into an array and strips unknown fields', () => {
    const r = parseOrThrow(chatRequestSchema, { ...valid, stop: 'END', user: 'someone', extra: 1 }) as Record<string, unknown>;
    expect(r.stop).toEqual(['END']);
    expect(r.user).toBeUndefined();
  });
  it.each([
    [{ ...valid, model: '' }],
    [{ ...valid, messages: [] }],
    [{ ...valid, messages: [{ role: 'tool', content: 'x' }] }],
    [{ ...valid, messages: [{ role: 'user', content: ['array', 'content'] }] }],
    [{ ...valid, temperature: 3 }],
    [{ ...valid, top_p: -0.1 }],
    [{ ...valid, max_tokens: 0 }],
    [{ ...valid, n: 2 }],
    [{ ...valid, stream: 'yes' }],
    [{ ...valid, tools: [{ type: 'function' }] }],
    [{ ...valid, response_format: { type: 'json_object' } }],
    [{ ...valid, tool_choice: 'auto' }],
    [{ ...valid, logprobs: true }],
  ])('rejects invalid input %#', (bad) => {
    expect(() => parseOrThrow(chatRequestSchema, bad)).toThrow(AppError);
  });
  it('explains that unsupported parameters are rejected rather than silently dropped', () => {
    expect(() => parseOrThrow(chatRequestSchema, { ...valid, tools: [] .concat([1] as never[]) })).toThrow(/tools.*not supported/);
    expect(() => parseOrThrow(chatRequestSchema, { ...valid, tools: null })).not.toThrow();
  });
  it('never echoes prompt content in validation errors', () => {
    try {
      parseOrThrow(chatRequestSchema, { model: 'm', temperature: 99, messages: [{ role: 'user', content: 'TOP-SECRET-PROMPT' }] });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AppError).message).not.toContain('TOP-SECRET-PROMPT');
      expect((e as AppError).code).toBe('INVALID_REQUEST');
    }
  });
});
