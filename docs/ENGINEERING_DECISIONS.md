# Engineering decisions

Each entry: what was chosen, why, and the main trade-off. The guiding principle: **engineering judgment, not technology collecting** — every dependency must earn its place.

## Core stack
**Express + TypeScript (strict).** The gateway is I/O-bound request plumbing; Express is small, ubiquitous and keeps control flow explicit (no framework magic to explain). TypeScript with `strict` + `noUncheckedIndexedAccess` catches the null/undefined and index mistakes that matter in proxy code. No NestJS/ORM: a thin, typed module layout with injected dependencies is enough and keeps the SQL visible.

**Raw `pg` with parameterised SQL (no ORM).** The interesting queries (atomic budget reservation, pgvector search, date_trunc aggregates) are clearer and more controllable as SQL. Trade-off: no generated types — mitigated by narrow repository/classes and integration tests.

## Data stores
**PostgreSQL** for everything that must be durable or relational: tenants, hashed keys, usage, logs, audit. Transactions and row-level locking give the budget its correctness.

**pgvector inside PostgreSQL** (not a separate vector DB). The semantic cache is small, tenant-scoped and needs transactional deletes/expiry next to relational data; one fewer system to run, secure and back up. Trade-off: HNSW approximate search with filters can give false misses, and it would not scale to very large vector corpora (a dedicated vector store would be justified then, not now).

**Redis** only for disposable, latency-critical state: rate-limit buckets and the exact cache (TTL, atomic scripts, sub-millisecond reads). Never the primary datastore; running it without persistence and with `volatile-lru` is safe because losing it only costs cache hits and refills buckets.

## Limiting
**Token bucket.** Allows bursts up to a capacity while enforcing a sustained rate, which matches interactive LLM traffic better than a fixed window (no boundary double-burst) and is cheap to store (two fields).

**Lua script.** A rate limiter's correctness *is* atomicity. GET/compute/SET races admit extra requests under concurrency; a single script makes refill + check + consume indivisible and uses Redis `TIME` so instance clock skew cannot matter. Trade-off: logic lives in a string inside TypeScript; it is covered by a concurrency integration test.

**Reserve → settle token budget in PostgreSQL.** Exact usage is unknown until the provider answers, so an atomic conditional `UPDATE` reserves an estimate (bounding concurrent spend) and settle replaces it with actuals. Trade-off: estimation error and a leaked reservation on crash are documented limitations; the alternative (check-then-spend) allows unbounded overshoot under concurrency.

## Caching
**Exact cache first, semantic second.** Exact hits are free and perfectly safe; semantic hits are probabilistic. Both are **tenant-scoped** (a shared cache would leak one tenant's answers to another and allow probing). The semantic cache binds a `context_hash` (model, params, system prompt, earlier turns) so only the last user message may differ — the main defence against wrong hits. The threshold is configurable and tunable, with no claim that 0.92 is optimal. **Built-in lexical embedder** keeps zero-cost operation; a neural one is a plug-in.

## Reliability
**Provider abstraction (`LLMProvider` + `ProviderManager`).** Business logic never touches vendor code; adding a provider is an adapter + registry line. Groq, Gemini and OpenRouter all expose OpenAI-compatible endpoints, so one adapter serves all three. Known gap: no model-alias mapping, so cross-vendor failover needs identical model IDs (see PROVIDER_FALLBACK.md).

**Fallback with an eligibility policy.** Retry/fail over only for failures another provider could plausibly fix (timeouts, network, 5xx, upstream 429, malformed responses); return client errors immediately. Blind fallback hides bugs and multiplies load.

**Bounded retries.** One retry, only for network/5xx, with full-jitter backoff, behind the breaker and under a total deadline — so outages are not amplified into retry storms.

**Circuit breaker, in-process.** Fast, dependency-free and testable. Trade-off: not shared across instances (documented); an epoch guard makes late in-flight results harmless.

## Observability and operations
**Asynchronous batched request logging.** Keeps the database off the request path. In-memory queue with backoff, overflow accounting, poison-row isolation and shutdown flush; a durable queue was rejected as added latency and complexity (crash loss ≤ one flush interval is accepted and documented).

**Prometheus metrics with bounded labels.** Standard, free, and cardinality-safe; per-tenant/request detail stays in PostgreSQL.

**`/health` vs `/ready`.** Liveness ignores dependencies; readiness checks PostgreSQL and Redis but not providers, so provider outages don't take the gateway out of rotation.

## API and transport
**OpenAI-compatible API.** The de-facto standard: clients switch by changing a base URL. Unsupported parameters (`tools`, `response_format`, …) are **rejected** rather than silently dropped, because quietly ignoring them returns wrong-shaped answers.

**SSE for streaming.** Matches the OpenAI wire format, works through ordinary HTTP infrastructure, one-directional (no WebSocket needed). Fallback only before the first chunk; mid-stream failure ends with an explicit error event.

**HMAC-SHA256 with a pepper for API keys.** Keys are 256-bit random, so a fast keyed hash is secure and adds no per-request latency; bcrypt/argon2 exist for low-entropy passwords. **Static admin token:** simple and adequate for a single-operator portfolio system; a real deployment would add per-user auth (documented limitation).

## Delivery
**Mock provider mode.** Makes the entire system demonstrable and testable for free and deterministically (latency, failures, mid-stream cuts), including in CI.

**Docker Compose as the canonical deployment.** One command, no cloud account, reproducible. Hardened containers (non-root, read-only, no capabilities, loopback ports). Cloud is documented as optional.

**Integration tests on real PostgreSQL and Redis** (isolated schema/DB per suite) instead of mocks, because the properties that matter — atomic reservations, Lua atomicity, pgvector queries — only exist in the real systems.

## Deliberately NOT used
| Not used | Why |
|---|---|
| Kafka, RabbitMQ, NATS, BullMQ, Celery, Temporal | No durable-async workload needs them; request logging is a batched in-process queue. They would add operational surface without a requirement (see the interview guide for when Kafka would become justified). |
| Kubernetes, Terraform | A single-host Compose deployment is sufficient; both add cost and complexity with no benefit at this scale. |
| GraphQL | The API is a small REST surface plus an OpenAI-compatible endpoint. |
| Elasticsearch, MongoDB | PostgreSQL already covers logs and documents (JSONB); no search or document-store need. |
| Separate vector database | pgvector in the existing PostgreSQL is enough for a tenant-scoped cache. |
| ORM / NestJS / LangChain | Not needed; they obscure the behaviour the project exists to demonstrate. |
| WebSockets | Polling and SSE cover the dashboard and streaming. |
| JWT for tenants | Opaque revocable API keys are simpler and revocation is immediate. |
| Paid monitoring / SaaS | Prometheus-format metrics + structured logs + local dashboard suffice. |

## Decisions revisited during review
Found while reviewing the finished code and fixed: unsupported OpenAI parameters were silently dropped (now rejected); provider `fetch` followed redirects (now refused); API-key prefix collisions would have returned a 500 (now retried); `last_used_at` wrote on every request (now throttled to once a minute per key); no model listing endpoint (added `GET /v1/models`). See `SECURITY_AUDIT.md`.
