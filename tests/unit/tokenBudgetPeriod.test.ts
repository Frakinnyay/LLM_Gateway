import { TokenBudget } from '../../packages/rate-limit/src/tokenBudget';

describe('TokenBudget.periodStart (monthly reset boundary, UTC)', () => {
  it('formats the first day of the UTC month', () => {
    expect(TokenBudget.periodStart(new Date('2026-11-07T10:00:00Z'))).toBe('2026-11-01');
    expect(TokenBudget.periodStart(new Date('2026-01-31T23:59:59Z'))).toBe('2026-01-01');
  });
  it('rolls over exactly at UTC midnight, independent of local timezone', () => {
    expect(TokenBudget.periodStart(new Date('2026-11-30T23:59:59.999Z'))).toBe('2026-11-01');
    expect(TokenBudget.periodStart(new Date('2026-12-01T00:00:00.000Z'))).toBe('2026-12-01');
  });
});
