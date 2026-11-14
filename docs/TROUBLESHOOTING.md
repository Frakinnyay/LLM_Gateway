# Troubleshooting

First step for any problem: take the `X-Request-ID` from the response (also inside every error body) and search the gateway logs for it: `docker compose logs gateway | grep <id>`; the same ID is in `request_logs.request_id` and `/api/requests`.

## Startup
| Symptom | Cause / fix |
|---|---|
| `Invalid configuration: - API_KEY_PEPPER: must be >= 32 chars` (or similar) | A required variable is missing/short. Run `npm run setup` (creates `.env` with random secrets) or fix `.env`. See `docs/CONFIGURATION.md`. |
| `... is still a placeholder` | `NODE_ENV=production` rejects `REPLACE_ME…` secrets. Use `npm run setup`. |
| `GROQ_API_KEY is required when its provider is enabled` | Set the key or `GROQ_ENABLED=false`. With no real keys use `MOCK_PROVIDER_ENABLED=true`. |
| `At least one provider must be enabled` | Enable the mock provider or a real one. |
| Compose: `env file .env not found` / `variable is not set: run npm run setup` | Run `npm run setup` first. |
| Migration fails with `extension "vector" is not available` | The database image lacks pgvector. Use `pgvector/pgvector:pg16` (the compose files do); for managed Postgres, verify pgvector support. |
| `port is already allocated` (5432/6379/8080/8081) | Another Postgres/Redis/dev server is running. Stop it, or stop the dev stack before the full stack (`npm run infra:down`). |
| `npm ci` fails: no lockfile / `EUSAGE` | Run `npm install` once and commit `package-lock.json` (CI and the Docker build use it when present). |

## Runtime
| Symptom | Cause / fix |
|---|---|
| `/ready` returns 503 | `checks` shows which of Postgres/Redis is down. `/health` stays 200 by design. |
| 401 `INVALID_API_KEY` | Wrong/revoked key, suspended tenant, or the pepper changed since the key was created (all old keys become invalid). Create a new key. |
| 401 on `/api/*` | Use `ADMIN_API_TOKEN`, not a tenant key. |
| 404 `MODEL_NOT_FOUND` | No configured provider serves that model ID. `GET /v1/models` lists valid IDs (mock: `mock-model`). |
| 503 `NO_PROVIDER_AVAILABLE` | Every provider for the model is disabled (dashboard/admin API) — enable one. Circuit-open providers are skipped, but if all are OPEN this is also returned until a cooldown elapses. |
| 400 `INVALID_REQUEST: tools: is not supported by this gateway` | Tool calling, JSON mode, logprobs are not implemented. Remove the parameter or call the provider directly for that feature. |
| 429 `RATE_LIMIT_EXCEEDED` | Wait `Retry-After`, or raise `RATE_LIMIT_CAPACITY` / `RATE_LIMIT_REFILL_PER_SEC`. |
| 429 `TOKEN_BUDGET_EXCEEDED` though usage looks low | The budget check reserves `max_tokens` (or `OUTPUT_TOKEN_RESERVE`, default 1024) up front. Send a smaller `max_tokens`, or raise the tenant's budget. |
| 413 `REQUEST_TOO_LARGE` | Body above `REQUEST_BODY_LIMIT`. |
| 502 `PROVIDER_MISCONFIGURED` | The provider rejected our credential (401/403). Check the key and base URL. |
| 504 `PROVIDER_TIMEOUT` | Raise `PROVIDER_TIMEOUT_MS` (streams: time to first chunk) or check the provider. |
| Semantic cache never hits | Check `SEMANTIC_CACHE_ENABLED=true` and the `X-Semantic-Similarity` header. The default `hash` embedder is lexical, so true paraphrases score low; use `EMBEDDING_PROVIDER=transformers` or lower the threshold (watch precision). The last message must be from the user, and system prompt/model/params must match exactly. |
| Always `X-Cache: BYPASS` | The client sends `Cache-Control: no-cache`/`no-store`. |
| Cache hit returns an "old" answer | Expected for exact repeats (TTL `EXACT_CACHE_TTL_SECONDS`); use `Cache-Control: no-cache` for a fresh sample. |
| Dashboard rows/costs missing or delayed | Request logs are asynchronous (~1 s) and only for authenticated chat requests. Costs are `—` when no price exists in `config/pricing.json`. |
| Dashboard: sign-in loops back | The token is wrong or the gateway rejected it (401). It is not persisted: a page refresh signs you out. |
| Dashboard shows "Could not refresh" | Gateway not reachable through the proxy; check `docker compose ps` / logs. |
| Streaming arrives all at once | A proxy is buffering SSE. Disable buffering (`proxy_buffering off`; the bundled nginx does). |
| Stream ends without `[DONE]` and with an `error` event | The provider failed mid-stream; the gateway cannot switch providers after sending bytes. Retry the request. |
| Request logs missing after a crash | In-memory queue: up to one flush interval can be lost on a hard crash. `gateway_request_log_dropped_total` counts overflow drops. |
| Leaked budget reservation (usage stuck) | A crash between reserve and settle leaves `reserved_tokens` set. When no requests are in flight: `UPDATE usage_records SET reserved_tokens = 0;`. |

## If Redis or PostgreSQL is down
* **Redis down:** rate limiter fails open (default) or returns 503 (`RATE_LIMIT_FAIL_OPEN=false`); caches degrade to misses; `/ready` is 503.
* **PostgreSQL down:** authentication cannot run (requests fail with a generic 500), `/ready` is 503; the request-log queue retains entries and retries (up to its cap).

## Tests and tooling
| Symptom | Fix |
|---|---|
| Integration tests cannot connect | `npm run infra:up`, or set `TEST_DATABASE_URL` / `TEST_REDIS_URL`. They use a throw-away schema and Redis DB 15. |
| `options` / search_path errors in tests | Requires `pg` ≥ 8.x with connection `options` support; upgrade `pg`. |
| `npm run lint` reports issues on first run | ESLint could not be executed where the project was authored; fix or relax the flagged rule in `eslint.config.mjs`. |
| `scripts/verify.sh` fails with `docker not found` | Install Docker, or run `bash scripts/verify.sh --skip-docker --skip-integration` (the result is then labelled "not a full verification"). |
| Windows | Use `scripts\verify.ps1`; for bash scripts use WSL/Git Bash and ensure LF line endings. |
| k6 `open()` cannot find the dataset | Pass `-e DATASET=<path relative to the script>` or run from `load-tests/`. |
