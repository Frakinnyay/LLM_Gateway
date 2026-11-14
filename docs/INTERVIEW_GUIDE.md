# Interview guide

Answers are written to be accurate to *this* implementation, including its limits. If asked about a number (hit rate, latency, throughput), say you measured it with the procedure in `docs/LOAD_TESTING.md` — or that you haven't yet. Do not quote placeholders.

## Backend

**Why Express?** The gateway is I/O-bound plumbing (auth, limits, proxying, SSE). Express is minimal and well understood, keeps the control flow explicit, and has mature middleware (helmet, cors). A heavier framework (NestJS) would add abstraction I'd have to defend without adding capability here. Async handlers are wrapped so rejections reach one central error handler.

**Why TypeScript?** Proxy code is full of "might be undefined" paths (provider responses, optional params, array indexing). `strict` and `noUncheckedIndexedAccess` turn those into compile-time errors; Zod validates the runtime boundary, and types flow from there.

**How is authentication implemented?** Tenant keys look like `lgw_<prefix>_<secret>`. I store only the public prefix (unique index) and `HMAC-SHA256(pepper, key)`. A request looks up the prefix, recomputes the HMAC, compares in constant time, and checks key and tenant status. All failures return the same 401. Plaintext is shown once at creation. HMAC rather than bcrypt because the key is 256 bits of randomness, not a human password — a slow hash would only add latency per request. Admin endpoints use a separate static token (a known limitation: no per-user identity).

**How is configuration handled?** Environment variables validated with Zod at startup; the process fails fast with clear messages (missing secrets, enabled provider without a key, placeholder secrets in production). One `buildDeps` function wires everything, and integration tests use the same wiring.

## Redis

**Why Redis?** For disposable, latency-critical state: rate-limit buckets and the exact cache. It offers atomic scripts, TTLs and sub-millisecond reads. It is never the source of truth; I run it without persistence because losing it only costs cache hits.

**Why Lua?** Atomicity. A rate limiter that does GET, computes, then SET lets two concurrent requests read the same token count and both be admitted. A Lua script runs as one indivisible step: read time from Redis `TIME`, refill, check, consume, set TTL, return the decision. Using Redis's clock also removes dependence on app-server clock skew. The script touches one key, so it's Cluster-safe.

**Why token bucket?** It permits bursts up to a capacity while enforcing a sustained rate — a good fit for interactive LLM traffic — and avoids fixed-window boundary spikes. State is two fields per tenant, with a TTL so idle buckets disappear.

**What happens under concurrent requests?** The script serialises them inside Redis. My integration tests fire 40 simultaneous HTTP requests and 200 simultaneous limiter calls at a capacity-5 bucket and assert exactly five are admitted. (Written and reviewed; I'd say whether I've run them against real Redis.)

**What if Redis is unavailable?** Configurable: fail open (default; serve the request, the Postgres budget still caps spend) or fail closed with 503. Cache reads degrade to misses; readiness goes 503 while liveness stays 200.

## PostgreSQL

**Why PostgreSQL?** Durable relational data with transactions and row locking: tenants, hashed keys, usage, logs, audit. The token budget's correctness depends on atomic conditional updates.

**Why pgvector?** The semantic cache needs nearest-neighbour search, and keeping it in PostgreSQL means one fewer system to operate, transactional expiry and tenant filtering next to the relational data. A dedicated vector DB would be justified for very large corpora, not for a tenant-scoped cache.

**How does semantic search work?** The last user message is embedded to a 384-d vector; the query orders by cosine distance (`embedding <=> query`) within `(tenant, context_hash, not expired)` and returns the nearest row; similarity = `1 − distance`; accept if it is ≥ the threshold.

**What indexes are used?** Unique `api_keys(key_prefix)` for auth; `(tenant_id, period_start)` primary key on usage; `request_logs` indexes on time, tenant+time, request ID and cache status; `semantic_cache(tenant_id, context_hash)`, `expires_at`, and an HNSW index with `vector_cosine_ops`. HNSW is approximate and filters apply during the scan, so a selective filter can cause a false miss but never a wrong hit.

## Caching

**Exact vs semantic?** Exact: a deterministic key over tenant, model, every message and every generation parameter — free and perfectly safe. Semantic: probabilistic, so it sits second, behind stricter scoping.

**How do you prevent incorrect semantic hits?** Three layers: tenant scoping; a `context_hash` that must match exactly (model, temperature, top_p, max_tokens, stop, system prompt and all earlier turns) so only the final user message may differ; and a conservative, tunable threshold with the similarity returned in a header for tuning. I also reject, rather than ignore, parameters I can't honour.

**Why 0.92?** It's a conservative default, not an optimum — I don't claim otherwise. The right value depends on the embedder and traffic. Higher: fewer wrong matches, lower hit rate; lower: more hits, more risk of an inappropriate answer.

**How would you tune it?** Build labelled prompt pairs (should share an answer / should not), run the sweep script to get precision and recall per threshold, pick the lowest threshold that meets a precision target (e.g. ≥ 99%), then validate end to end with the cache benchmark and watch `X-Semantic-Similarity` in production for near-misses. Note the built-in embedder is lexical: on my four test pairs "capital of France vs Germany" scored higher (0.81) than a real paraphrase (0.60), which is exactly why a neural embedder plus a measured threshold matters.

## Reliability

**Why a circuit breaker?** When a provider is down, every request would otherwise pay a timeout and retry before failing over, and the struggling provider keeps getting hammered. The breaker opens after N consecutive failures, skips the provider for a cooldown, then lets one probe through (HALF_OPEN): success closes it, failure re-opens it.

**How does it behave concurrently?** Transitions are synchronous in Node, so acquiring a permit is atomic. Late results from requests that started in an earlier state would be harmful, so each permit carries an epoch; stale results are ignored. Unit tests pin this and fail if the guard is removed.

**Why fallback, and which errors trigger it?** Availability across vendors. It triggers for failures another provider could fix: timeouts, network errors, 5xx, upstream 429, malformed responses. Client errors (400/422), unknown model, and rejected credentials are returned, not failed over — the same bad request would fail identically elsewhere. Fallback only happens between providers that serve the same model ID.

**What happens when every provider fails?** 502 (or 504 for a timeout), 503 if none could even be attempted; the token reservation is released, nothing is cached, and the failure is logged and counted.

**How do you avoid retry storms?** One retry only, only for network/5xx, with full-jitter backoff, never while the breaker isn't CLOSED, every retry passes through the breaker (so failures trip it fast), and everything shares a total deadline. No retry for timeouts.

## Streaming

**How does SSE work here?** `text/event-stream`; each provider chunk is normalised and written as `data: {...}\n\n`, ending with `data: [DONE]`, with backpressure handled via `drain`. It's true streaming — the gateway never buffers the answer first (cache hits are the one exception: replayed from storage).

**How do you handle provider stream failure?** Before the first chunk: normal retry/fallback and, if exhausted, a proper JSON error. After bytes are sent I can't change the status or switch providers (that would splice two generations), so I emit an in-band error event and end without `[DONE]`; it counts against the breaker and tokens produced are charged. Idle and max-duration timeouts bound silent or runaway streams; a client disconnect aborts upstream and is neutral for the breaker.

## Observability

**What metrics matter?** Request rate/errors/latency per route, cache hit ratio, provider attempt outcomes and failures, fallback count, circuit state, tokens and estimated cost, rate-limit and budget rejections, and log-drop count (an alert condition).

**Why avoid high-cardinality labels?** Every distinct label combination is a separate time series stored by the app and Prometheus. Tenant IDs, request IDs or raw URLs are unbounded (or attacker-controlled), so they cause memory growth, slow queries and let an attacker inflate cost. Labels come from closed sets; per-tenant detail is in PostgreSQL.

**Why is logging asynchronous, and what's the trade-off?** To keep the database off the request path. The in-memory queue is batched, retried with backoff, bounded (drops oldest and counts), isolates poison rows, and flushes on shutdown. The cost: a hard crash can lose up to one flush interval. A durable queue would remove that at the price of latency and a new dependency.

## Distributed systems

**What race conditions exist?** Rate limit — solved by one Lua script. Budget — solved by an atomic conditional UPDATE under a row lock (reserve/settle). Circuit breaker — epoch guard. Remaining: concurrent identical cache misses each call the provider (no single-flight; benign), and a crash between reserve and settle leaks a reservation.

**How do concurrent rate-limit requests behave?** Serialised inside Redis; exactly the bucket's capacity is admitted from any burst.

**What if Redis is unavailable? PostgreSQL?** Redis: limiter fails open/closed by config, caches miss, `/ready` 503. PostgreSQL: authentication can't run so requests fail with a generic 500, `/ready` 503; the log queue retains entries and retries.

**Where does state live in a multi-instance deployment?** Durable state in PostgreSQL, limits/cache in Redis — shared. Breaker state and runtime toggles are per process (a known limitation; shared state would cost a network call per request).

## Cost

**How does caching reduce cost?** A hit makes no provider call and charges no budget; the log records `estimated_savings` from the cached entry's original usage. Savings = Σ savings / (spent + saved) over a window.

**How is cost estimated?** `(in × price_in + out × price_out) / 1e6` from a configurable price file keyed by provider:model. Missing price or unknown usage yields `null`, never a guess; estimated token counts are flagged.

**What happens when pricing changes?** Update the file; new requests use the new prices; past rows keep what was estimated at the time (they're estimates, not billing records).

## Security

**How are API keys protected?** Hashed with a server-side pepper (never stored in plaintext, shown once), constant-time comparison, immediate revocation, uniform 401s. **What secrets are logged?** None: keys, admin token and provider keys are redacted/never logged; prompts and responses are not logged either; a test asserts it. **How do you prevent abuse?** Per-tenant rate limit and token budget, body-size/message limits (after auth), timeouts, bounded retries and queues. Honest gaps: no auth-failure throttling (do it at the proxy), static admin token. **SSRF?** Outbound URLs come only from config, forwarded fields are whitelisted, redirects are refused. **Privacy of prompts?** Caches store prompts/responses in plaintext until TTL; mitigations: `no-store`, disabling the semantic cache, short TTLs, disk encryption.

## System design

**How would you scale this gateway?** First, measure. The gateway is stateless apart from breaker/toggle/log-queue, so run several instances behind a load balancer. Then remove per-request database work: cache auth lookups briefly (accepting slightly delayed revocation), move budget counters to Redis with periodic reconciliation, batch more aggressively, and size connection pools.

**What changes at 1,000 requests/sec?** Likely: auth lookup and budget reserve/settle become the bottleneck (a hot row per tenant) → short-TTL auth cache, Redis-backed budget counters; larger log batches and monthly partitioning of `request_logs`; connection-pool tuning; multiple instances with a shared Redis-backed breaker if outage detection time matters.

**At 100,000 requests/sec?** Treat it as a data plane: many gateway instances; Redis Cluster for limiter/cache (the Lua script is single-key, so tenant buckets shard cleanly); budgets as sharded counters with asynchronous persistence; request logs streamed through a durable log (Kafka) to an analytics store instead of per-row Postgres inserts; semantic cache moved to a dedicated, sharded vector store; edge/CDN-level protections; separate control plane (admin API, dashboard) from the data plane.

**When would Redis Cluster be needed?** When a single Redis node's memory or command throughput (or availability requirements) is exceeded — not before; one node with replicas is simpler.

**When would you introduce Kafka?** When log/event volume or consumer count outgrows batched DB writes: several independent consumers (billing, analytics, alerting), replay, backpressure and durability guarantees. At this project's scale it would be pure overhead.

**When would you separate services?** When parts scale or change independently or are owned by different teams: control plane vs data plane, a dedicated embedding/semantic-cache service, a billing/usage pipeline. Not before there's a concrete reason.

## "What would you do differently?" (good closing answers)
Run the concurrency/integration suite against real services and publish measured benchmarks; add per-user admin auth and auth-failure throttling; share breaker state; add `/v1/embeddings` and tool-call pass-through for agent workloads; add retention for logs; commit the lockfile and add dependency scanning.
