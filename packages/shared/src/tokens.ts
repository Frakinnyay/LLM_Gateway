/**
 * Rough approximation (~4 chars/token). This is NOT a tokenizer: it is used only for
 * budget reservations and when a provider reports no usage, and such counts are always
 * flagged as estimated.
 */
export function approximateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
