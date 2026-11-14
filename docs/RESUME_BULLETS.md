# Resume bullets

Fill the placeholders **only** with numbers you measured yourself (`docs/LOAD_TESTING.md`). Delete any bullet whose number you did not measure. Do not claim a deployment, CI pass, or test coverage you have not actually run.

> **LLM Gateway — Multi-Provider API Proxy** | Node.js, TypeScript, Express, PostgreSQL/pgvector, Redis, React, Docker

> - Built an OpenAI-compatible LLM gateway with SSE streaming, tenant-scoped hashed API keys, an atomic Redis Lua token-bucket rate limiter and a reserve/settle monthly token budget enforced in PostgreSQL.
> - Implemented two-level caching (tenant-scoped exact Redis cache + pgvector semantic cache with a context-hash guard against cross-context hits), achieving **[X]% cache hit rate** and **[Y]% estimated cost reduction** on a **[N]-request benchmark** (threshold **[T]** tuned for precision on labelled pairs).
> - Implemented multi-provider fallback (Groq, Gemini, OpenRouter) with a per-provider circuit breaker, bounded jittered retries and a failure-eligibility policy, recovering **[X]%** of requests during simulated provider failures with p95 gateway overhead of **[Z] ms**.
> - Added asynchronous batched request logging (backoff, bounded queue, shutdown flush), Prometheus metrics with bounded label cardinality, health/readiness probes and a React monitoring dashboard with live provider enable/disable for failover demos.
> - Wrote unit and Supertest integration tests (including concurrency tests for rate limiting, budgets and cache), k6 load/failure scripts, hardened Docker Compose deployment and GitHub Actions CI; deliberately avoided unneeded infrastructure (no Kafka/Kubernetes) and documented the trade-offs.

Shorter variants:

> - Designed a multi-tenant LLM API gateway (Node/TypeScript, PostgreSQL+pgvector, Redis) with atomic rate limiting, token budgets, exact+semantic caching and provider failover; **[X]%** hit rate, **[Y]%** est. cost reduction on a **[N]**-request benchmark.
> - Engineered reliability features — circuit breakers, bounded retries, mid-stream failure handling for SSE — and verified concurrency-sensitive paths with integration tests against real PostgreSQL/Redis.

Placeholders: `[X]` cache hit rate · `[Y]` estimated cost reduction · `[N]` benchmark size · `[T]` threshold · `[Z]` p95 gateway overhead (ms) · fallback recovery `[X]`.
