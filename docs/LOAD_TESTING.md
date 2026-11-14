# Load testing & benchmark procedure

> **Status: scripts IMPLEMENTED, none EXECUTED.** k6 was not available where this repository was authored, so no
> number in this project is a measured result. Every results table below is `TBD` until *you* run the procedure.
> Never copy a number into the README/resume that did not come from your own run.

## Prerequisites

* [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) installed (free, open source).
* The stack running: `docker compose up -d postgres redis`, `npm run migrate`, `npm run dev` (or the full compose stack).
* A tenant API key: `npm run create-tenant -- bench 1000000000` (large budget so the token budget never interferes).
* **Relax the limits that would otherwise throttle the test** (rate limiting is a feature, not a bug, but it would hide what you measure):
  `RATE_LIMIT_CAPACITY=100000 RATE_LIMIT_REFILL_PER_SEC=100000`.
* Run k6, the gateway, Postgres, Redis and the upstream on a machine that is otherwise idle; note CPU/RAM. A laptop running
  everything shares CPU between load generator and system under test, so absolute numbers are indicative only.
  Compare runs *relative to each other on the same machine*.

## Benchmark 1 — cache hit rate  (`load-tests/cache.js`)

Measures exact, semantic and overall hit rate on a workload of repeated and paraphrased prompts.

```bash
node scripts/gen-cache-dataset.js 500 1 > load-tests/data/cache_workload.json   # synthetic, seeded, ordered
# fresh state: new tenant key, and flush caches
docker compose exec redis redis-cli -n 0 FLUSHDB
docker compose exec postgres psql -U gateway -d llm_gateway -c "TRUNCATE semantic_cache"
k6 run -e API_KEY=<key> -e ADMIN_TOKEN=<admin> load-tests/cache.js
```

* Output: `load-tests/results/cache-<timestamp>.json` with exact / semantic / overall hit rate and a per-kind breakdown
  (`new`, `exact_repeat`, `paraphrase`).
* **What the number means:** the dataset mix (40% new, 30% exact repeats, 30% paraphrases) is an *assumption*. The hit
  rate describes this workload, this embedder and this threshold. Report all three alongside the number.
* Repeat with `EMBEDDING_PROVIDER=transformers` and with different `SEMANTIC_CACHE_THRESHOLD` values (e.g. 0.85, 0.90, 0.92, 0.95).
  Also run `npm run threshold-sweep -- <labelled pairs>` to see precision/recall: a higher hit rate is not better if the
  extra hits are wrong answers.

## Benchmark 2 — gateway overhead  (`load-tests/gateway.js`)

Compares `client -> upstream` with `client -> gateway -> upstream` against the **same deterministic upstream**, so the
difference is the gateway's added latency rather than provider noise.

```bash
# 1. zero-cost deterministic upstream with fixed latency
LATENCY_MS=50 PORT=9099 node scripts/mock-upstream.js &

# 2. gateway pointed at it (use a provider slot; the key is a dummy)
MOCK_PROVIDER_ENABLED=false GROQ_ENABLED=true GROQ_API_KEY=dummy GROQ_BASE_URL=http://localhost:9099/v1 \
  PROVIDER_PRIORITY=groq npm run dev

# 3. baseline: straight to the upstream
k6 run -e TARGET=direct  -e UPSTREAM_URL=http://localhost:9099/v1 -e MODEL=llama-3.3-70b-versatile -e RATE=50 -e DURATION=60s load-tests/gateway.js
# 4. through the gateway (uncached path: Cache-Control: no-cache)
k6 run -e TARGET=gateway -e API_KEY=<key> -e MODEL=llama-3.3-70b-versatile -e RATE=50 -e DURATION=60s load-tests/gateway.js
```

* Run each at least 3 times after a warm-up run; compare **medians of p50/p95/p99** and report the spread.
* `gateway overhead = gateway latency − direct latency` (per percentile). Both use an open-model constant arrival rate
  to avoid coordinated omission. Raise `RATE` until achieved rps falls below target to find saturation (that is a throughput limit, not an overhead).
* Overhead includes: auth (one Postgres lookup), rate limit (one Redis call), budget reserve/settle (2 Postgres writes),
  cache lookups (Redis; plus embedding + pgvector query if the semantic cache is on), logging (async, off the request path).
  Toggle `SEMANTIC_CACHE_ENABLED` to see its cost separately.

## Benchmark 3 — estimated cost with vs. without cache

Uses the cache run's readout. `config/pricing.json` **must contain real, current prices** for the model you use
(the bundled mock price is illustrative). Costs are *estimates*: provider-reported tokens when available, otherwise approximations.

```
cost_without_cache = estimated_cost_usd + estimated_savings_usd     # from GET /api/cache/stats (printed by cache.js teardown)
cost_with_cache    = estimated_cost_usd
savings_percent    = estimated_savings_usd / cost_without_cache
```

Cross-check against Prometheus: `sum(gateway_estimated_cost_total)`. If pricing is missing the gateway reports `null`
(never a guess) and the savings figure will be incomplete — fix the pricing file before drawing conclusions.

## Benchmark 4 — provider failure and recovery  (`load-tests/fallback.js`)

Zero cost with the two built-in mock providers (`MOCK_PROVIDER_INSTANCES=2`):

```bash
k6 run -e API_KEY=<key> -e ADMIN_TOKEN=<admin> -e FAULT=http_503 -e RATE=20 -e DURATION=30s load-tests/fallback.js
k6 run -e API_KEY=<key> -e ADMIN_TOKEN=<admin> -e FAULT=disable  -e RATE=20 -e DURATION=30s load-tests/fallback.js
```

Reports requests attempted, served via fallback, served via primary, failed, latency of the first N requests (before the
breaker opens: they pay for failed attempts/retries) versus later ones (breaker OPEN: the failing provider is skipped), and
`RECOVERY_SECONDS` after healing (for `http_503` this includes the breaker cooldown, `CB_COOLDOWN_MS`).
For a realistic result also repeat with real providers by disabling the primary from the dashboard while the test runs.

## Results (fill in from YOUR runs)

| Metric | Value | Conditions (machine, embedder, threshold, rate) |
|---|---|---|
| Exact cache hit rate | TBD | |
| Semantic cache hit rate | TBD | |
| Overall cache hit rate | TBD | |
| Gateway overhead p50 / p95 / p99 | TBD / TBD / TBD | |
| Estimated cost without cache → with cache | TBD → TBD | |
| Requests recovered via fallback (of attempted) | TBD | |
| Recovery time after healing | TBD | |
| Max sustained throughput | TBD | |

## Caveats

* Synthetic prompts are not real traffic; semantic-cache outcomes especially depend on the prompt distribution.
* The built-in `hash` embedder is lexical. A semantic-cache benchmark with it measures word overlap, not meaning.
* Mock providers and the mock upstream have no network variance, so they understate real-provider tail latency.
* The circuit breaker is per gateway process; a multi-instance deployment behaves differently from one instance.
