import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Usage } from '../../providers/src/types';

const schema = z.object({
  currency: z.string().default('USD'),
  unit: z.literal('per_1M_tokens'),
  prices: z.record(z.object({ input: z.number().min(0), output: z.number().min(0) })),
});
export type PricingTable = z.infer<typeof schema>;

export const EMPTY_PRICING: PricingTable = { currency: 'USD', unit: 'per_1M_tokens', prices: {} };

/** Missing file => empty table (all costs null). Present-but-invalid file => throws, so a typo cannot silently zero out costs. */
export function loadPricing(path: string, warn: (msg: string) => void = () => undefined): PricingTable {
  if (!existsSync(path)) {
    warn(`pricing file not found at ${path}; estimated costs will be null`);
    return EMPTY_PRICING;
  }
  const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new Error(`Invalid pricing file ${path}: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

/** Estimated USD cost, or null when pricing or usage is unavailable. Never invents a value. */
export function estimateCost(table: PricingTable, provider: string, model: string, usage: Usage | null | undefined): number | null {
  if (!usage) return null;
  const price = table.prices[`${provider}:${model}`] ?? table.prices[`*:${model}`];
  if (!price) return null;
  return (usage.promptTokens * price.input + usage.completionTokens * price.output) / 1_000_000;
}
