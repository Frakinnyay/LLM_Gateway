import { z } from 'zod';
import { AppError } from '../../../packages/shared/src/errors';

/**
 * OpenAI parameters this gateway does NOT implement. They are rejected (400) instead of silently dropped, because dropping
 * e.g. `tools` or `response_format` would return a plain-text answer to a client that expects structured output.
 * Other unknown fields (e.g. `user`, `seed`, `presence_penalty`) are ignored and not forwarded.
 */
const unsupported = z.unknown().refine((v) => v === undefined || v === null, { message: 'is not supported by this gateway' });

export const chatRequestSchema = z.object({
  tools: unsupported, tool_choice: unsupported, functions: unsupported, function_call: unsupported,
  response_format: unsupported, logprobs: unsupported, top_logprobs: unsupported,
  model: z.string().min(1).max(128),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().max(200_000), // multimodal content arrays are not supported
  })).min(1).max(200),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().min(1).max(131_072).optional(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).optional()
    .transform((s) => (s === undefined ? undefined : Array.isArray(s) ? s : [s])),
  n: z.literal(1).optional(),
  stream: z.boolean().optional().default(false),
});
// Unknown top-level fields (e.g. `user`) are stripped, not forwarded.


/** Validates input; error messages cite field paths only and never echo prompt content. */
export function parseOrThrow<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const i = r.error.issues[0];
  const where = i && i.path.length ? i.path.join('.') : 'body';
  throw new AppError(400, 'invalid_request_error', 'INVALID_REQUEST', `Invalid request: ${where}: ${i?.message ?? 'invalid'}`);
}
