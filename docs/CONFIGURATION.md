# Configuration reference

All settings come from environment variables, validated at startup with Zod (`packages/config/src/index.ts`). The process refuses to start with a clear message if a required value is missing/invalid, an enabled provider has no key, no provider is enabled, or (in `production`) a secret is still a placeholder. This table is generated from the schema; `.env.example` is a ready-to-copy template and `npm run setup` creates `.env` with random secrets.

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test` or `production`. In `production`, placeholder secrets (`REPLACE_ME…`) are rejected at startup. |
| `PORT` | `8080` | HTTP listen port. |
| `LOG_LEVEL` | `info` | pino level: fatal, error, warn, info, debug, trace. |
| `DATABASE_URL` | **required** | PostgreSQL connection string (database must allow `CREATE EXTENSION vector`). |
| `REDIS_URL` | **required** | Redis connection string. |
| `API_KEY_PEPPER` | **required** | Secret (>=32 chars) mixed into the HMAC-SHA256 hash of gateway API keys. **Changing it invalidates every existing key.** |
| `ADMIN_API_TOKEN` | **required** | Secret (>=32 chars) bearer token for `/api/*` (and `/metrics` if `METRICS_REQUIRE_AUTH`). |
| `MOCK_PROVIDER_ENABLED` | `false` | Enable the free local mock provider(s). Needs no API key. |
| `MOCK_PROVIDER_LATENCY_MS` | `50` | Artificial latency per mock call (streams use min(latency, 20 ms) per chunk). |
| `MOCK_PROVIDER_INSTANCES` | `2` | Number of mock instances (`mock`, `mock-2`, …, max 5) so failover can be demonstrated without keys. |
| `MOCK_PROVIDER_FAILURE_RATE` | `0` | Random failure probability 0–1 for mock calls. |
| `GROQ_ENABLED` | `false` | Enable the Groq provider (requires `GROQ_API_KEY`). |
| `GROQ_API_KEY` | *(empty)* | Groq API key (optional unless enabled). |
| `GROQ_BASE_URL` | `https://api.groq.com/openai/v1` | OpenAI-compatible base URL. **Operator-controlled only; never taken from requests (SSRF boundary).** |
| `GEMINI_ENABLED` | `false` | Enable the Gemini provider via its OpenAI-compatible endpoint. |
| `GEMINI_API_KEY` | *(empty)* | Gemini API key. |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta/openai` | OpenAI-compatible base URL. |
| `OPENROUTER_ENABLED` | `false` | Enable OpenRouter. |
| `OPENROUTER_API_KEY` | *(empty)* | OpenRouter API key. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible base URL. |
| `GROQ_MODELS` | `llama-3.3-70b-versatile` | Comma-separated model IDs served via Groq. Verify against the provider's current docs. |
| `GEMINI_MODELS` | `gemini-2.0-flash` | Models served via Gemini. |
| `OPENROUTER_MODELS` | `meta-llama/llama-3.3-70b-instruct:free` | Models served via OpenRouter. |
| `PROVIDER_PRIORITY` | `mock,groq,gemini,openrouter` | Fallback order (names). Registered providers missing from the list are appended (e.g. `mock-2`). Fallback only happens between providers that list the **same model ID**. |
| `PROVIDER_TIMEOUT_MS` | `30000` | Per-attempt timeout; for streams, the time to the first chunk. |
| `STREAM_IDLE_TIMEOUT_MS` | `30000` | Max gap between stream chunks. |
| `STREAM_MAX_DURATION_MS` | `300000` | Hard cap on one stream. |
| `STREAM_INCLUDE_USAGE` | `false` | Send `stream_options.include_usage` upstream. Off because not every provider accepts it; without it stream usage is estimated. |
| `PROVIDER_TOTAL_TIMEOUT_MS` | `60000` | Deadline across all attempts (retries + fallbacks) of one request. |
| `PROVIDER_MAX_RETRIES` | `1` | Same-provider retries for network/5xx only (0–3). |
| `PROVIDER_RETRY_BASE_DELAY_MS` | `100` | Backoff base; full jitter, doubled per retry, capped at 2 s. |
| `REQUEST_BODY_LIMIT` | `256kb` | Max request body (e.g. `256kb`); larger bodies get 413. |
| `DEFAULT_MONTHLY_TOKEN_BUDGET` | `1000000` | Budget for tenants created without an explicit one. |
| `RATE_LIMIT_CAPACITY` | `60` | Token-bucket capacity (burst size) per tenant. |
| `RATE_LIMIT_REFILL_PER_SEC` | `1` | Token-bucket refill rate per tenant (sustained requests/second). |
| `RATE_LIMIT_FAIL_OPEN` | `true` | If Redis is unreachable: `true` serves the request (budget still enforced), `false` returns 503. |
| `OUTPUT_TOKEN_RESERVE` | `1024` | Output tokens reserved against the budget when a request has no `max_tokens`. |
| `EXACT_CACHE_MAX_BYTES` | `262144` | Responses larger than this are not cached. |
| `EXACT_CACHE_TTL_SECONDS` | `3600` | Exact-cache entry lifetime. |
| `SEMANTIC_CACHE_ENABLED` | `false` | Enable the pgvector semantic cache (second level). |
| `SEMANTIC_CACHE_THRESHOLD` | `0.92` | Minimum cosine similarity (0–1) for a semantic hit. **Tune on your data** (`npm run threshold-sweep`); no value is claimed optimal. |
| `SEMANTIC_CACHE_TTL_SECONDS` | `86400` | Semantic entry lifetime (expired rows are ignored immediately and purged hourly). |
| `EMBEDDING_PROVIDER` | `hash` | `hash` (built-in, lexical only) or `transformers` (optional local neural model). |
| `EMBEDDING_DIMENSIONS` | `384` | Must be 384 until the `semantic_cache.embedding` column type is migrated. |
| `CB_FAILURE_THRESHOLD` | `5` | Consecutive failures that open a provider's circuit. |
| `CB_COOLDOWN_MS` | `30000` | Time OPEN before a probe is allowed. |
| `CB_HALF_OPEN_MAX_REQUESTS` | `1` | Concurrent probe requests in HALF_OPEN. |
| `PRICING_FILE` | `config/pricing.json` | Per-1M-token price table (relative to the working directory). Missing price ⇒ cost `null`. |
| `REQUEST_LOG_QUEUE_MAX` | `10000` | In-memory request-log queue bound; oldest dropped (and counted) on overflow. |
| `REQUEST_LOG_BATCH_SIZE` | `100` | Rows per INSERT. |
| `REQUEST_LOG_FLUSH_INTERVAL_MS` | `1000` | Flush timer. |
| `METRICS_REQUIRE_AUTH` | `false` | Require the admin token on `/metrics`. |
| `CORS_ORIGINS` | *(empty: no cross-origin access)* | Comma-separated allowed browser origins. |

Compose-only variable: `POSTGRES_PASSWORD` (default `gateway`, local use only). Test-only: `TEST_DATABASE_URL`, `TEST_REDIS_URL` (see `tests/integration/helpers.ts`).

Booleans are the literal strings `true` / `false`.
