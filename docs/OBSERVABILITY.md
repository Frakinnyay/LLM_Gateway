# Observability

No paid monitoring is required. The gateway exposes Prometheus-compatible metrics, structured JSON logs with request IDs, a dashboard, and queryable request history in PostgreSQL.

## Endpoints
| | Meaning |
|---|---|
| `GET /health` | **Liveness** — the process is up. Never fails because of PostgreSQL, Redis or providers (so an orchestrator will not restart a healthy process during an outage). |
| `GET /ready` | **Readiness** — PostgreSQL *and* Redis answer; else `503` with `{checks:{postgres,redis}}`. Provider health is intentionally excluded: all providers being down should not remove the gateway from rotation (it can still serve cache hits and return clear errors). |
| `GET /metrics` | Prometheus text. Open by default; set `METRICS_REQUIRE_AUTH=true` to require the admin bearer token. |

## Metrics

| Metric | Labels | Notes |
|---|---|---|
| `gateway_requests_total` | `route`, `status` | `route` is a fixed template (`chat_completions`, `models`, `api_keys`, `health`, …, `other`), never the raw URL. Aborted requests are `499`. |
| `gateway_request_duration_seconds` | `route` | Histogram, buckets 5 ms … 60 s. |
| `gateway_cache_hits_total` | `type` = `exact`/`semantic` | |
| `gateway_cache_misses_total` | – | Counts only requests that consulted the cache. |
| `gateway_provider_requests_total` | `provider`, `outcome` | Outcome = `success`, `circuit_open`, or a failure kind (`timeout`, `network`, `upstream_5xx`, …). One increment per attempt. |
| `gateway_provider_failures_total` | `provider`, `kind` | Failed attempts only. |
| `gateway_fallback_total` | `from`, `to` | Requests served by a non-primary provider. |
| `gateway_tokens_total` | `provider`, `direction` = `input`/`output` | Tokens spent at providers (cache hits excluded). May include estimated counts. |
| `gateway_estimated_cost_total` | `provider` | USD estimate from `config/pricing.json`; only added when a price exists. |
| `gateway_rate_limit_rejections_total` | – | |
| `gateway_budget_rejections_total` | – | |
| `gateway_request_log_dropped_total` | – | Request-log entries lost to queue overflow — alert on any increase. |
| `gateway_circuit_breaker_state` | `provider` | 0 closed, 1 half-open, 2 open (read live at scrape time). |
| Node defaults | – | Event-loop lag, memory, GC, handles (`prom-client` defaults). |

### Why high-cardinality data is not in labels
Each distinct label combination is a separate time series held in memory by the gateway **and** by Prometheus, and indexed/queried there. Tenant IDs, API keys, request IDs, raw URLs or
user-supplied model names are unbounded (or attacker-controlled), so using them as labels grows memory without limit, slows queries and can take monitoring down — and an attacker could
inflate it by varying the value. All labels here come from small closed sets (route templates, status codes, configured provider names, fixed enums). Per-tenant and per-request detail lives in PostgreSQL
(`request_logs`, `/api/requests`, `/api/usage`).

### Example queries
```promql
# error ratio of chat requests (5m)
sum(rate(gateway_requests_total{route="chat_completions",status=~"5.."}[5m])) / sum(rate(gateway_requests_total{route="chat_completions"}[5m]))
# p95 latency
histogram_quantile(0.95, sum by (le) (rate(gateway_request_duration_seconds_bucket{route="chat_completions"}[5m])))
# cache hit ratio
sum(rate(gateway_cache_hits_total[5m])) / (sum(rate(gateway_cache_hits_total[5m])) + sum(rate(gateway_cache_misses_total[5m])))
# any provider circuit open
max by (provider) (gateway_circuit_breaker_state) == 2
```
Minimal scrape config (Prometheus is optional and not bundled):
```yaml
scrape_configs:
  - job_name: llm-gateway
    static_configs: [{ targets: ["localhost:8080"] }]
    # authorization: { credentials: "<ADMIN_API_TOKEN>" }   # when METRICS_REQUIRE_AUTH=true
```

## Logs
Structured JSON (pino). One `request` line per response: `requestId, method, route, status, latencyMs, tenantId, provider, cache, errorCode`. Provider attempts, breaker transitions and fallbacks log as `provider event`.
The `X-Request-ID` (client-supplied if valid, else generated) is returned to the caller, included in every error body, forwarded to providers as `x-request-id`, and stored in `request_logs.request_id`, so one ID links the client, the logs and the database row.
Not logged: API keys, admin token, provider credentials, prompts and responses (pino also redacts `authorization`, `apiKey`, `password`-style fields defensively). Unexpected errors are logged server-side with stack; clients only get `INTERNAL_ERROR` + `request_id`.

## Asynchronous request log
`enqueue()` is synchronous and never touches the database, so request latency is unaffected. Batches (`REQUEST_LOG_BATCH_SIZE`, `REQUEST_LOG_FLUSH_INTERVAL_MS`) are written with one multi-row INSERT.

| Failure | Behaviour |
|---|---|
| Database down | Batch kept and retried with exponential backoff (1 s … 30 s). |
| Queue full (`REQUEST_LOG_QUEUE_MAX`) | Oldest entries dropped and counted (`gateway_request_log_dropped_total`, warning log). |
| One bad row (constraint violation) | Retried row by row; only that row is dropped, with an error log. |
| Shutdown | `close()` flushes with a deadline; anything left is emitted to the application log as JSON before exit. |
| Hard crash | Up to one flush interval of entries can be lost (in-memory queue). |

Trade-off: a durable queue (Redis stream or outbox table) would survive crashes but adds latency, a dependency and failure modes this project deliberately avoids. Only authenticated chat requests are persisted, so anonymous traffic cannot flood the table.

## Dashboard
React dashboard (`apps/dashboard`) polls the admin API every few seconds: provider status/controls, cache statistics, cost chart, request table, and a "Try it" panel. Data derives from the asynchronous log, so it can lag by about a second.
