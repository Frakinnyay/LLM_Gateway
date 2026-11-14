# API reference

Machine-readable spec: [`openapi.yaml`](openapi.yaml) (OpenAPI 3.0). Two auth schemes:

* **Tenant API key** — `Authorization: Bearer lgw_<prefix>_<secret>` for `/v1/*`.
* **Admin token** — `Authorization: Bearer <ADMIN_API_TOKEN>` for `/api/*` (and optionally `/metrics`). The admin token is a single shared secret with no per-user identity; a tenant API key is **not** accepted on `/api/*`.

Every response carries `X-Request-ID` (a valid client-supplied ID matching `^[A-Za-z0-9._-]{8,128}$` is echoed; otherwise one is generated).

## OpenAI-compatible endpoints

### `POST /v1/chat/completions`

Request (supported fields):

| Field | Notes |
|---|---|
| `model` (string, required) | Must be served by a configured, enabled provider (`GET /v1/models`). |
| `messages` (required, 1–200) | `role` ∈ `system`/`user`/`assistant`; `content` must be a **string** (no multimodal arrays). |
| `temperature` 0–2, `top_p` 0–1, `max_tokens` 1–131072, `stop` (string or ≤4 strings) | Forwarded and part of the cache key. |
| `stream` (bool) | `true` ⇒ Server-Sent Events, see [STREAMING.md](STREAMING.md). |
| `n` | Only `1` is accepted. |

**Rejected with 400** (not silently dropped): `tools`, `tool_choice`, `functions`, `function_call`, `response_format`, `logprobs`, `top_logprobs`. **Ignored and not forwarded:** other unknown fields (`user`, `seed`, `presence_penalty`, `frequency_penalty`, `logit_bias`, …).

Response: an OpenAI-style `chat.completion` (or `chat.completion.chunk` stream). The body is normalised; provider-specific extras are dropped. `usage` is present only when the provider reported it.

Response headers:

| Header | Meaning |
|---|---|
| `X-Cache` | `HIT`, `MISS`, or `BYPASS` (client sent `Cache-Control: no-cache`/`no-store`). Absent on errors raised before the cache is consulted. |
| `X-Cache-Type` | `exact` or `semantic` (on hits). |
| `X-Semantic-Similarity` | Cosine similarity of the nearest semantic candidate (hit or miss), 4 decimals. |
| `X-Provider` | Provider that produced (or originally produced, for hits) the answer. |
| `X-Fallback-Used` | `true` if a provider other than the primary served it. |
| `X-RateLimit-Limit`, `X-RateLimit-Remaining` | Token-bucket state. |
| `Retry-After` | Seconds, on 429 rate-limit rejections. |

Request header `Cache-Control: no-cache` skips cache reads (and refreshes); `no-store` skips reads and writes.

### `GET /v1/models`
OpenAI-style list of models of configured **and enabled** providers (`owned_by` = first provider serving it).

## Operations

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness. Always 200 while the process runs; ignores dependencies and providers. |
| `GET /ready` | none | Readiness: 200 only if PostgreSQL **and** Redis respond, else 503 with per-check booleans. Provider state never affects it. |
| `GET /metrics` | none (or admin if `METRICS_REQUIRE_AUTH=true`) | Prometheus text format. See [OBSERVABILITY.md](OBSERVABILITY.md). |

## Admin API (`/api/*`, admin token)

| Endpoint | Purpose |
|---|---|
| `POST /api/tenants` `{name, monthly_token_budget?}` | Create a tenant → `201 {id, name}`; `409 TENANT_EXISTS`. |
| `POST /api/keys` `{tenant_id, label?}` | Create a key → `201 {id, prefix, api_key, note}`. **The plaintext `api_key` is shown only here.** |
| `GET /api/keys?tenant_id=` | List key metadata (id, prefix, label, status, created/last used). Never secrets or hashes. |
| `DELETE /api/keys/:id` | Revoke → `204`. Effective immediately. |
| `GET /api/providers` | Providers with `health` (`healthy`/`disabled`/`circuit_open`/`circuit_half_open`), circuit snapshot, models. |
| `POST /api/providers/:p/disable` · `/enable` | Runtime toggle; persisted in `provider_configs` and audit-logged. |
| `POST /api/providers/:p/failure-mode` `{mode}` | **Mock providers only** (demo chaos): `none`, `http_500`, `http_503`, `timeout`, `bad_request`, `stream_cut`. |
| `GET /api/usage?tenant_id=` | Monthly budget and last 12 months of token usage. |
| `GET /api/requests?tenant_id=&limit=&before=` | Cursor-paginated request log (newest first); `next_cursor` is the last row id. |
| `GET /api/cache/stats?hours=&tenant_id=` | Exact/semantic hits, misses, hit rate (`null` until data exists), estimated savings, semantic entries. |
| `GET /api/costs?hours=&bucket=hour\|day&tenant_id=` | Estimated cost and savings per time bucket. |

Dashboard data lags real time by up to the request-log flush interval (default 1 s) because logging is asynchronous.

## Errors

Every error uses one shape; internals, stack traces, upstream bodies and credentials never appear:

```json
{ "error": { "message": "Rate limit exceeded", "type": "rate_limit_error", "code": "RATE_LIMIT_EXCEEDED", "request_id": "…" } }
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `INVALID_REQUEST` | Validation failed (message names the field, never echoes content), including unsupported parameters. |
| 400 | `INVALID_JSON` | Body is not valid JSON. |
| 400 | `PROVIDER_REJECTED_REQUEST` | Provider rejected the request (not retried, not failed over). |
| 400 | `NOT_A_MOCK_PROVIDER` | `failure-mode` was called on a non-mock provider. |
| 401 | `INVALID_API_KEY` / `INVALID_ADMIN_TOKEN` | Missing/malformed/unknown/revoked key, suspended tenant, or bad admin token (identical response for all key failures). |
| 404 | `MODEL_NOT_FOUND`, `NOT_FOUND`, `TENANT_NOT_FOUND`, `KEY_NOT_FOUND`, `PROVIDER_NOT_FOUND` | Unknown resource. |
| 409 | `TENANT_EXISTS` | Duplicate tenant name. |
| 413 | `REQUEST_TOO_LARGE` | Body above `REQUEST_BODY_LIMIT` (checked only after authentication). |
| 429 | `RATE_LIMIT_EXCEEDED` | Token bucket empty; see `Retry-After`. |
| 429 | `TOKEN_BUDGET_EXCEEDED` | Monthly budget cannot cover this request's reservation. |
| 499 | `CLIENT_CLOSED_REQUEST` | Client disconnected mid-request (rarely observable by the client). |
| 502 | `PROVIDER_ERROR`, `PROVIDER_MISCONFIGURED` | Provider failure after retries/fallback; upstream credential problem. |
| 503 | `NO_PROVIDER_AVAILABLE`, `RATE_LIMITER_UNAVAILABLE` | Every provider for the model disabled/open; Redis down with `RATE_LIMIT_FAIL_OPEN=false`. |
| 504 | `PROVIDER_TIMEOUT` | Provider (and fallbacks) timed out. |
| 500 | `INTERNAL_ERROR` | Unexpected failure; details only in server logs, keyed by `request_id`. |

Streaming requests that fail **after** the first chunk cannot change the HTTP status; they end with an in-band `data: {"error":{…}}` event (see STREAMING.md).

## Not implemented

`/v1/embeddings`, `/v1/completions`, tool/function calling, JSON mode, vision/multimodal input, `n > 1`. These are outside this project's scope; see [DOGFOODING.md](DOGFOODING.md) for what that means for existing apps.
