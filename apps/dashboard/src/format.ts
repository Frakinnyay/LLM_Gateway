/** Pure display helpers (no React) so they can be unit-tested. */

export function fmtCost(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'; // unknown pricing is shown as unknown, never as 0
  if (n === 0) return '$0';
  return n < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(4)}`;
}

export function fmtTokens(total: number | null, estimated: boolean): string {
  if (total === null) return '—';
  return `${estimated ? '~' : ''}${total.toLocaleString('en-US')}`;
}

export function fmtPercent(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

export type Health = 'healthy' | 'disabled' | 'circuit_open' | 'circuit_half_open';
export const HEALTH_LABEL: Record<Health, string> = {
  healthy: 'Healthy',
  disabled: 'Disabled',
  circuit_open: 'Circuit Open',
  circuit_half_open: 'Circuit Half-Open',
};

/** Bar heights (px) scaled to the largest value; all-zero input yields zero-height bars rather than NaN. */
export function scaleBars(values: number[], maxHeight: number): number[] {
  const max = Math.max(0, ...values);
  return values.map((v) => (max === 0 ? 0 : Math.round((v / max) * maxHeight)));
}
