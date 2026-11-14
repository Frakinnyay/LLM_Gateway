# Portfolio description

## One line
An OpenAI-compatible gateway that puts authentication, rate limiting, token budgets, caching, provider failover and observability between applications and multiple LLM providers — fully runnable locally at zero cost.

## Technical description
LLM Gateway is a TypeScript/Express service that exposes `POST /v1/chat/completions` (JSON and Server-Sent-Events streaming) and routes requests to Groq, Gemini, OpenRouter or built-in mock providers. Each tenant has hashed, revocable API keys, a Redis token-bucket rate limit (one atomic Lua script) and a monthly token budget enforced with an atomic reserve/settle protocol in PostgreSQL. A tenant-scoped exact cache (Redis) and a pgvector semantic cache (guarded by a context hash and a tunable similarity threshold) avoid repeat provider calls. A provider manager applies a failure-eligibility policy, bounded jittered retries and per-provider circuit breakers; streams fail over only before the first byte and report mid-stream failures explicitly. Requests are logged asynchronously and exposed through Prometheus metrics with bounded labels and a small React dashboard that can disable providers live for failover demos.

## Architecture summary
Express app → request ID/observer → API-key auth → Zod validation → Redis rate limit → exact then semantic cache → PostgreSQL token reservation → `ProviderManager` (breaker, retry, fallback) → provider adapter → settle usage, populate caches, async request log. PostgreSQL holds durable/relational state and pgvector; Redis holds disposable limiter and cache state. Docker Compose is the canonical deployment (hardened containers, one-shot migrations, nginx-served dashboard).

## Engineering challenges
* **Atomicity under concurrency:** rate limiting via a single Lua script; budget enforcement via a conditional `UPDATE` under row locks; both tested with simultaneous requests.
* **Cache correctness:** keys cover every response-affecting parameter and the tenant; the semantic cache can only differ in the last user message, with the threshold treated as a measured precision/recall trade-off rather than a magic number.
* **Failure semantics:** which errors justify retry or fallback, avoiding retry storms, stale in-flight results confusing a circuit breaker (epoch guard), and the impossibility of failing over mid-stream.
* **Honest observability:** bounded metric labels, asynchronous logging that cannot silently drop data, and costs reported as `null` rather than invented when prices or usage are unknown.
* **Zero-budget operation:** mock providers with injectable latency, errors and mid-stream cuts make every feature demonstrable and testable for free.

## Measurable results (fill in from your own runs — see `docs/LOAD_TESTING.md`)
| Metric | Result |
|---|---|
| Cache hit rate (exact / semantic / overall) | TBD / TBD / TBD |
| p50 / p95 / p99 gateway overhead | TBD / TBD / TBD |
| Estimated cost without cache → with cache | TBD → TBD |
| Requests recovered via fallback during primary failure | TBD |
| Recovery time after provider heals | TBD |
| Sustained throughput | TBD |
| Test status (unit / integration / CI) | TBD — record what you actually ran |

## Demo
`npm run setup && docker compose up --build`, then follow `docs/DEMO_SCRIPT.md` (cache hit, semantic hit, rate limit, failover, circuit breaker CLOSED→OPEN→HALF_OPEN→CLOSED, streaming, dashboard) — no API keys or money needed.

## GitHub README introduction
> **LLM Gateway** is a production-oriented, OpenAI-compatible gateway for multiple LLM providers. It adds tenant API keys, atomic Redis rate limiting, token budgets, exact and pgvector semantic caching, provider fallback with circuit breakers, SSE streaming, asynchronous logging and Prometheus metrics. It runs entirely locally with Docker Compose and mock providers, so you can try every feature without an API key or a cloud account.
