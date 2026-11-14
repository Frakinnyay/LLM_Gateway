# Security

Scope: what the gateway does to protect keys, tenants and upstream credentials, and what it leaves to the deployer. The review log is in [SECURITY_AUDIT.md](SECURITY_AUDIT.md). Nothing here is a claim that the system is "secure" in an absolute sense.

## Authentication and authorization
* **Tenant API keys** (`lgw_<8-hex prefix>_<256-bit secret>`): only the prefix and `HMAC-SHA256(pepper, key)` are stored; plaintext is shown once at creation. Verification uses a constant-time compare. HMAC (not bcrypt/argon2) is appropriate because keys are 256-bit random values, not human passwords; slow hashes would only add per-request latency. Changing `API_KEY_PEPPER` invalidates all keys.
* Lookup is by public prefix (indexed), then hash comparison. Failures (malformed, unknown, wrong secret, revoked, suspended tenant) return the **same** 401 and body.
* **Revocation** is immediate (checked against PostgreSQL on every request); suspended tenants' keys stop working.
* **Admin API** (`/api/*`): one static bearer token (`ADMIN_API_TOKEN`, ≥32 chars), compared in constant time. A tenant key is never accepted there. There is no per-user identity or role model — restrict the admin surface at the network level for anything non-local.
* Provider enable/disable and mock failure modes require the admin token (never unauthenticated) and are written to `audit_logs`.

## Input handling
* Zod validation on every body/query/param; unknown fields are stripped; unsupported OpenAI parameters are rejected explicitly. Validation errors name the field, never echo content.
* Body size limit (`REQUEST_BODY_LIMIT`, default 256 kb) enforced by the JSON parser, **after** authentication so anonymous callers cannot make the gateway buffer bodies.
* All SQL is parameterised (the only interpolated fragment, `date_trunc` unit, comes from a two-value Zod enum). Redis keys are built from UUIDs and SHA-256 hex only; user text is hashed, never used as a key or command argument.

## SSRF and outbound traffic
The gateway only calls provider base URLs from **configuration** (never request data), forwards only whitelisted fields, and sets `redirect: 'error'` so credentials cannot be bounced to another host.
Operators must treat `*_BASE_URL` as trusted input (they are not restricted to public IPs).

## Secrets
No secrets in source. `.env` is git-ignored and generated with random values (`npm run setup`, mode 600). Production mode rejects placeholder secrets. Config validation fails fast on missing/short secrets or enabled providers without keys.
Provider keys never appear in responses, logs or metrics.

## Tenant isolation
Exact-cache keys include the tenant; semantic cache rows are filtered by tenant and context hash; rate limits and budgets are per tenant; admin queries take an explicit tenant filter. Responses never cross tenants.

## Transport and headers
`helmet` security headers, `x-powered-by` disabled, CORS allowlist (`CORS_ORIGINS`; empty ⇒ no CORS headers). The dashboard's nginx adds a CSP, `X-Frame-Options: DENY` and `no-referrer`. **TLS is not terminated by the gateway**: put a TLS proxy in front for any non-local use.

## Error responses and logging
One error shape; no stack traces, SQL, upstream bodies, credentials or internal hostnames. Server logs carry the stack, keyed by `request_id`. Logs never contain API keys, the admin token, or prompt/response text.
**Privacy implication of caching/logging prompts:** `request_logs` stores metadata only, but `semantic_cache.prompt_text` and cached responses (Redis and PostgreSQL) contain user content in plaintext until they expire. Prompts may contain personal or confidential data: set TTLs deliberately, encrypt disks/volumes, restrict database access, and consider disabling the semantic cache (`SEMANTIC_CACHE_ENABLED=false`) or sending `Cache-Control: no-store` for sensitive workloads. Upstream providers also receive the prompts — their data policies apply.

## Abuse resistance
Per-tenant token-bucket rate limit, monthly token budget, request size and message-count limits, per-attempt/total provider timeouts, bounded retries, bounded queues and caches (Redis `maxmemory`, TTLs, log-queue cap). Not provided: per-IP limits or auth-failure throttling (use the reverse proxy), WAF, DDoS protection.

## Container hardening
Non-root user, read-only root filesystem, all capabilities dropped, `no-new-privileges`, loopback-only published ports, minimal Alpine images, healthchecks.

## Deployer checklist
Set strong `API_KEY_PEPPER`/`ADMIN_API_TOKEN`/`POSTGRES_PASSWORD`; terminate TLS; restrict `/api` and `/metrics`; add auth-failure throttling at the proxy; back up PostgreSQL; add log/usage retention; keep dependencies updated (`npm audit`); decide on prompt retention. See `AWS_DEPLOYMENT.md` for cloud-specific notes.
