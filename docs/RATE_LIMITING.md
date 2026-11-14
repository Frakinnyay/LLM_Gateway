# Rate limiting and token budgets

Two independent controls protect the gateway and the budget:

| Control | Unit | Store | Scope | Response |
|---|---|---|---|---|
| Rate limit (token bucket) | requests/second | Redis (Lua) | per tenant | `429 RATE_LIMIT_EXCEEDED` + `Retry-After` |
| Token budget | tokens/month | PostgreSQL | per tenant | `429 TOKEN_BUDGET_EXCEEDED` |

## Token bucket (Redis + Lua)

Each tenant has a bucket with `RATE_LIMIT_CAPACITY` tokens (burst) refilling at `RATE_LIMIT_REFILL_PER_SEC`. A request costs 1 token.
Key: `llmgw:v1:rl:tenant:<tenantId>` (a hash with fields `tokens`, `ts`).

The whole decision runs as **one Lua script** (`packages/rate-limit/src/tokenBucket.ts`):

1. Read the time from Redis (`TIME`), not from the app server.
2. Load `tokens` and `ts`; a missing bucket starts full.
3. Refill: `tokens = min(capacity, tokens + elapsed_seconds * rate)` (fractional tokens are kept).
4. If `tokens >= cost`: subtract and allow; otherwise deny and compute `retry_after_ms = ceil((cost - tokens) / rate * 1000)`.
5. Store `tokens`/`ts` and set `PEXPIRE` to twice the full-refill time (idle buckets disappear).
6. Return `{allowed, floor(tokens), retry_after_ms}`.

### Why not GET / modify / SET?

```text
Client A: GET tokens -> 1          Client B: GET tokens -> 1
Client A: SET tokens = 0 (allowed) Client B: SET tokens = 0 (allowed)    <- both admitted, limit exceeded
```
Reading and writing in separate commands lets concurrent requests act on the same stale value. Redis executes a Lua script atomically
(no other command interleaves), so the read-refill-check-consume sequence is one indivisible step. Using Redis `TIME` also keeps multiple
gateway instances with skewed clocks consistent. The script touches a single key, so it is Redis-Cluster-safe.

The integration tests fire 40 simultaneous HTTP requests and 200 simultaneous limiter calls at a capacity-5 bucket and assert exactly 5 are admitted
(`tests/integration/rateLimit.test.ts`; written, **not yet executed**).

### If Redis is unavailable
`RATE_LIMIT_FAIL_OPEN=true` (default) serves the request and logs a warning — favouring availability; the Postgres token budget still bounds spend.
`false` returns `503 RATE_LIMITER_UNAVAILABLE` — favouring protection. Cache reads also degrade to misses.

### Limitations
Rate limits are per tenant (not per key, not per IP). Failed authentication attempts are not rate limited by the gateway (put that at the reverse proxy).
Limits are not configurable per tenant yet.

## Token budget (reserve → settle → release)

Calculation: per request the gateway **reserves an estimate** before calling the provider and replaces it with actual usage afterwards.

* Estimate = `approx_tokens(all message text) + (max_tokens ?? OUTPUT_TOKEN_RESERVE)`, where `approx_tokens` is ~4 characters per token. **This is not a tokenizer.**
* **Reserve** (`UPDATE usage_records SET reserved_tokens = reserved_tokens + $n WHERE total_tokens + reserved_tokens + $n <= budget`): one atomic conditional
  update. PostgreSQL row locks serialise concurrent reservations for a tenant and re-check the `WHERE` after acquiring the lock, so concurrent requests cannot
  jointly exceed the budget at reservation time. If no row is updated → `429`. A request that lands **exactly** on the budget is allowed.
* **Settle** after success: `reserved_tokens -= reservation`, usage `+= actual`. **Release** if every provider failed (nothing was spent).
* Streams settle when the stream ends (including early/failed ends) with what was produced.
* **Actual usage:** the provider-reported `usage` when present. If the provider reports none, usage is *approximated* (same ~4 chars/token rule) and flagged `tokens_estimated`
  in the request log; counts are never presented as exact in that case.
* **Cache hits cost nothing**: no provider call, no budget charge (they still count against the rate limit).
* **Monthly reset:** usage rows are keyed by the UTC calendar month (`period_start`); a new month starts at zero with no cron job.

Residual imprecision, stated plainly: the budget can be exceeded by at most the gap between the estimate and actual input size; a very small budget can
reject a request that would have fit (because the reservation uses `max_tokens`); a process crash between reserve and settle leaks that request's reservation
until corrected manually (`UPDATE usage_records SET reserved_tokens = 0 …` when no requests are in flight).
