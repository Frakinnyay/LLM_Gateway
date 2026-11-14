import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const boolDefaultTrue = z
  .enum(['true', 'false'])
  .default('true')
  .transform((v) => v === 'true');

const providerName = z.enum(['mock', 'groq', 'gemini', 'openrouter']);
const csv = <T extends z.ZodTypeAny>(item: T, def: string) =>
  z
    .string()
    .default(def)
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(item));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  API_KEY_PEPPER: z.string().min(32, 'must be >= 32 chars'),
  ADMIN_API_TOKEN: z.string().min(32, 'must be >= 32 chars'),

  MOCK_PROVIDER_ENABLED: bool,
  MOCK_PROVIDER_LATENCY_MS: z.coerce.number().int().min(0).default(50),
  MOCK_PROVIDER_INSTANCES: z.coerce.number().int().min(1).max(5).default(2),
  MOCK_PROVIDER_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
  GROQ_ENABLED: bool,
  GROQ_API_KEY: z.string().default(''),
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
  GEMINI_ENABLED: bool,
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta/openai'),
  OPENROUTER_ENABLED: bool,
  OPENROUTER_API_KEY: z.string().default(''),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  GROQ_MODELS: csv(z.string(), 'llama-3.3-70b-versatile'),
  GEMINI_MODELS: csv(z.string(), 'gemini-2.0-flash'),
  OPENROUTER_MODELS: csv(z.string(), 'meta-llama/llama-3.3-70b-instruct:free'),
  PROVIDER_PRIORITY: csv(providerName, 'mock,groq,gemini,openrouter'),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).default(30000),
  STREAM_IDLE_TIMEOUT_MS: z.coerce.number().int().min(100).default(30000),
  STREAM_MAX_DURATION_MS: z.coerce.number().int().min(1000).default(300000),
  STREAM_INCLUDE_USAGE: bool,
  PROVIDER_TOTAL_TIMEOUT_MS: z.coerce.number().int().min(100).default(60000),
  PROVIDER_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(1),
  PROVIDER_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(100),

  REQUEST_BODY_LIMIT: z.string().default('256kb'),
  DEFAULT_MONTHLY_TOKEN_BUDGET: z.coerce.number().int().min(0).default(1_000_000),
  RATE_LIMIT_CAPACITY: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_REFILL_PER_SEC: z.coerce.number().positive().default(1),
  RATE_LIMIT_FAIL_OPEN: boolDefaultTrue,
  OUTPUT_TOKEN_RESERVE: z.coerce.number().int().min(1).default(1024),

  EXACT_CACHE_MAX_BYTES: z.coerce.number().int().min(1024).default(262144),
  EXACT_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).default(3600),
  SEMANTIC_CACHE_ENABLED: bool,
  SEMANTIC_CACHE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.92),
  SEMANTIC_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).default(86400),
  EMBEDDING_PROVIDER: z.enum(['hash', 'transformers']).default('hash'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(1).default(384),

  CB_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(5),
  CB_COOLDOWN_MS: z.coerce.number().int().min(100).default(30000),
  CB_HALF_OPEN_MAX_REQUESTS: z.coerce.number().int().min(1).default(1),

  PRICING_FILE: z.string().default('config/pricing.json'),
  REQUEST_LOG_QUEUE_MAX: z.coerce.number().int().min(10).default(10000),
  REQUEST_LOG_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  REQUEST_LOG_FLUSH_INTERVAL_MS: z.coerce.number().int().min(50).default(1000),
  METRICS_REQUIRE_AUTH: bool,

  CORS_ORIGINS: csv(z.string().url(), ''),
});

export type Config = z.infer<typeof schema>;

const PLACEHOLDER = /REPLACE_ME|change-?me/i;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const cfg = parsed.data;
  const problems: string[] = [];

  if (cfg.NODE_ENV === 'production') {
    if (PLACEHOLDER.test(cfg.API_KEY_PEPPER)) problems.push('API_KEY_PEPPER is still a placeholder');
    if (PLACEHOLDER.test(cfg.ADMIN_API_TOKEN)) problems.push('ADMIN_API_TOKEN is still a placeholder');
  }
  const needsKey: Array<[boolean, string, string]> = [
    [cfg.GROQ_ENABLED, 'GROQ_API_KEY', cfg.GROQ_API_KEY],
    [cfg.GEMINI_ENABLED, 'GEMINI_API_KEY', cfg.GEMINI_API_KEY],
    [cfg.OPENROUTER_ENABLED, 'OPENROUTER_API_KEY', cfg.OPENROUTER_API_KEY],
  ];
  for (const [enabled, name, value] of needsKey) {
    if (enabled && !value) problems.push(`${name} is required when its provider is enabled`);
  }
  if (!cfg.MOCK_PROVIDER_ENABLED && !cfg.GROQ_ENABLED && !cfg.GEMINI_ENABLED && !cfg.OPENROUTER_ENABLED) {
    problems.push('At least one provider must be enabled (MOCK_PROVIDER_ENABLED=true needs no API key)');
  }
  if (cfg.EMBEDDING_DIMENSIONS !== 384) {
    problems.push('EMBEDDING_DIMENSIONS must be 384 until the semantic_cache migration is changed');
  }
  if (problems.length) throw new Error(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return cfg;
}
