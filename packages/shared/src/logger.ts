import pino from 'pino';

/**
 * Structured logger. Redacts credentials defensively; callers must still avoid
 * logging prompt content or secrets (see docs/SECURITY.md).
 */
export function createLogger(level: string) {
  return pino({
    level,
    redact: {
      paths: ['req.headers.authorization', 'headers.authorization', '*.apiKey', '*.api_key', '*.password'],
      censor: '[REDACTED]',
    },
  });
}
export type Logger = ReturnType<typeof createLogger>;
