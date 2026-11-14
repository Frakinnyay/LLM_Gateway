import { estimateCost, type PricingTable } from '../../packages/shared/src/pricing';

const table: PricingTable = { currency: 'USD', unit: 'per_1M_tokens', prices: { '*:mock-model': { input: 0.1, output: 0.2 }, 'groq:x': { input: 1, output: 2 } } };
const usage = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500, estimated: false };

describe('estimateCost', () => {
  it('uses the wildcard price for any provider', () => {
    expect(estimateCost(table, 'mock-2', 'mock-model', usage)).toBeCloseTo((1000 * 0.1 + 500 * 0.2) / 1e6, 12);
  });
  it('prefers an exact provider:model price', () => {
    expect(estimateCost(table, 'groq', 'x', usage)).toBeCloseTo((1000 * 1 + 500 * 2) / 1e6, 12);
  });
  it('returns null (never a guess) when pricing or usage is unavailable', () => {
    expect(estimateCost(table, 'groq', 'unknown-model', usage)).toBeNull();
    expect(estimateCost(table, 'groq', 'x', null)).toBeNull();
  });
});
