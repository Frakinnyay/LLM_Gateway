# Security audit

**What this is:** a structured self-review of the finished repository by its author (an AI assistant working with the project owner), combining a manual read of every module with automated pattern scans.
**What this is not:** a penetration test, a dependency/CVE scan (`npm audit` was not run: no network and no lockfile where this was authored), or a review of a deployed system.
**Environment limits:** no PostgreSQL, Redis, Docker or provider access was available during authoring, so runtime behaviour that depends on them is reviewed by reading, not by exercise. The statements "fixed" below say how each fix was checked.
The system is **not** declared "secure"; several properties depend on how it is deployed (TLS, network exposure, secrets handling).

## Scope reviewed
Authentication/authorization, input validation, SQL/Redis construction, SSRF and outbound calls, secret handling, CORS/headers, error responses, logging/privacy, rate limiting/budget/cache races, resource lifecycle, metrics cardinality, container/compose configuration, dashboard token handling, CI workflow permissions.

## Automated scan results (executed)
| Check | Result |
|---|---|
| Secret-looking literals (`sk-`, `AIza`, `gsk_`, `AKIA`, PEM headers) outside docs | none found |
| `any`, `@ts-ignore`, `TODO/FIXME` in source | none |
| `console.*` in server code | only startup/connection-error reporting (`index.ts`, pool and Redis error listeners; messages only, no secrets) |
| `eval`, `child_process`, `exec/spawn` | none; one `new Function('s','return import(s)')` with a **constant** module name (optional ESM dependency loader) — see O9 |
| String-built SQL | two fragments: `date_trunc('${unit}')` where `unit` is a two-value Zod enum, and the column list of the request-log INSERT (a constant). Everything else is parameterised |
| Outbound `fetch` | only the provider adapter; base URL from validated config |
| Routes returning `err.message`/stack to clients | none |
| Browser storage in the dashboard | none (admin token held in memory only) |
| Config/.env consistency | every `cfg.X` used in code is in the schema; schema and `.env.example` match |
| Unused dependencies | none (all declared packages are imported or used by tooling) |
| Unused exports | one (`ValidChatRequest`) — removed |

## Findings fixed during the review
| ID | Severity | Finding | Fix | How checked |
|---|---|---|---|---|
| F1 | Medium (correctness/safety) | Unsupported OpenAI parameters (`tools`, `response_format`, …) were silently stripped, so clients expecting tool calls or JSON mode received plain text with no error. | Rejected with `400 INVALID_REQUEST`; ignored-but-harmless fields documented. | Schema + integration test written (**not executed**: needs Zod/Postgres). |
| F2 | Low | Provider `fetch` followed redirects by default; an upstream redirect could carry the request (and credentials) elsewhere. | `redirect: 'error'` on both provider calls. | Code review; **not exercised against a real redirect**. |
| F3 | Low | The 32-bit public API-key prefix is unique-constrained; a collision would surface as an unhandled 500 on key creation. | Retry with a fresh key (up to 5 attempts). | Unit tests with a fake pool (**executed**, pass). |
| F4 | Low (DoS/perf) | `last_used_at` was updated on every authenticated request, creating a hot row under load. | Throttled to once per minute per key (bounded in-memory map). | Unit test (**executed**, pass). |
| F5 | Info | No `GET /v1/models`; clients that probe it would fail. Dead export present. | Endpoint added; export removed. | Integration test written (not executed). |
| F6 | Medium (design) | Request body size was a risk before authentication (anonymous callers could make the server buffer bodies). | Body parsing mounted **after** the auth middleware. | Integration test written (not executed). |

## Open findings and accepted risks
| ID | Severity | Finding | Mitigation / recommendation |
|---|---|---|---|
| O1 | Medium | No throttling of failed authentication. Every unauthenticated request costs one indexed PostgreSQL lookup, so an anonymous flood can load the database. (Rate limiting applies only after auth, per tenant.) | Rate-limit/ban at the reverse proxy or WAF; optionally add an IP-keyed limiter (needs a trusted-proxy policy). |
| O2 | Medium | The admin API uses one static bearer token: no per-user identity, roles, audit of *who*, or rotation without a restart; the bundled nginx proxies `/api`. | Keep the token long/secret, restrict `/api` by network/IP, don't expose it publicly; real deployments need SSO/per-user auth. Constant-time compare and 256-bit generated default limit guessing. |
| O3 | Medium (privacy) | Prompts and responses are stored in plaintext in the semantic cache (PostgreSQL, incl. `prompt_text`) and exact cache (Redis) until expiry. | Disable the semantic cache or use `Cache-Control: no-store` for sensitive data; set short TTLs; encrypt volumes; restrict DB/Redis access. `request_logs` stores no content. |
| O4 | Low | Unbounded growth: `request_logs`, `audit_logs`, `usage_records` have no retention; `semantic_cache` has no per-tenant row cap (bounded only by TTL × per-tenant rate limit). | Add retention/partitioning before long-lived use. |
| O5 | Low | A crash between token reserve and settle leaks that reservation. | Documented; manual reset SQL in TROUBLESHOOTING.md; a reconciler job would fix it. |
| O6 | Low | `/metrics` is unauthenticated by default; `X-Provider`/`X-Fallback-Used` reveal provider names to clients. | `METRICS_REQUIRE_AUTH=true` or network ACLs; names are low-sensitivity. |
| O7 | Low | Circuit-breaker state and runtime provider toggles are per process; other instances pick up a toggle only on restart. | Documented; shared state is future work. |
| O8 | Info | The gateway does not terminate TLS. | Terminate TLS at a proxy; never expose container ports directly. |
| O9 | Info | `embedding.ts` uses `new Function('s','return import(s)')` to load an optional ESM-only package from CommonJS. The argument is a constant, never user data. | Acceptable; replace with native dynamic import if the project moves to ESM. |
| O10 | Medium (supply chain) | Dependencies have not been scanned and there is no committed lockfile. | `npm install`, commit `package-lock.json`, run `npm audit`, enable Dependabot; pin base images by digest for production. |
| O11 | Low | The dashboard keeps the admin token in JS memory; an XSS would expose it. | Strict CSP is set by nginx; no HTML injection sinks are used (React escaping); still prefer network-restricting the dashboard. |
| O12 | Info | Key lookup returns faster for unknown prefixes than for a known prefix with a wrong secret. The prefix is a public identifier, not a secret; the secret comparison is constant-time. | None needed. |
| O13 | Low | Upstream provider keys live in process env; anyone who can read the container env can read them. | Use a secret manager for deployments; never commit `.env`. |

## Specific checklist (requested items)
| Item | Assessment |
|---|---|
| Secrets in code | None found (scan). `.env` git-ignored; random secrets generated. |
| API key leakage | Hashed at rest, shown once, never listed/logged (log test written: asserts the key and admin token never appear in logs). |
| Unsafe logging | pino redaction + content never logged; unauthenticated requests not persisted. Unexpected errors log stacks server-side only. |
| SQL injection | All values parameterised; two non-parameterised fragments are constants/whitelisted. |
| Redis command injection | Keys are UUIDs or SHA-256 hex; user text is hashed; the Lua script receives numeric args only. |
| Missing validation | Zod on bodies, queries and params; request-ID header validated by regex. |
| Missing authorization | `/v1` requires a tenant key, `/api` the admin token; provider toggles/failure modes are admin-only and audited; `/health`, `/ready`, `/metrics` are intentionally open (see O6). |
| Unsafe CORS | Allowlist only; empty ⇒ no CORS headers. |
| Oversized requests | Body limit (after auth) + message-count/length caps. |
| Unbounded cache growth | Exact cache: TTL + `maxmemory` + `volatile-lru` + max entry size. Semantic: TTL + purge (see O4). |
| Unbounded metrics cardinality | All labels from closed sets (route templates, status, provider names, fixed enums). |
| Provider timeout issues | Per-attempt, total, stream idle and max-duration timeouts; abort on client disconnect. |
| SSRF | Only config-supplied base URLs; whitelisted forwarded fields; redirects refused. Operators must treat `*_BASE_URL` as trusted. |
| Race conditions | Rate limit (single Lua script), budget (conditional UPDATE under row lock), breaker (single-threaded + epoch guard), log queue (single-threaded). Remaining: cache stampede (benign duplicate calls), reservation leak on crash (O5). Concurrency tests written, not executed. |
| Resource leaks | Streams abort upstream and close generators on disconnect/error; timers cleared; shutdown drains the request-log queue, closes the pool and Redis. Not load-tested for leaks. |

## Environment-dependent (out of this codebase's control)
TLS and network exposure; secret storage and rotation; host/container patching; database and Redis access control and encryption at rest; backups; log retention and access; provider data-handling terms; the reverse proxy/WAF in front of the gateway.

## Re-run guidance
`npm audit`; `npm run lint`; integration + concurrency tests against real PostgreSQL/Redis (`npm run test:integration`); a load test for resource leaks (`docs/LOAD_TESTING.md`); a review of any change to auth, caching keys, or the provider adapter.
