# Cost and free-tier guide

**Goal: the complete project runs locally at zero cost.** Nothing in this repository requires a paid service, and no price or free-tier claim below should be treated as current — vendor terms change. Verify before relying on any of them.

## What costs nothing (local, open source)
| Piece | Notes |
|---|---|
| Node.js, TypeScript, Express, React, Vite | Open source. |
| PostgreSQL + pgvector, Redis | Open source, run as local containers. |
| Docker / Docker Compose | Docker Engine is open source. **Docker Desktop has its own licence terms** (free for personal use and small businesses at the time of writing — check the current terms); on Linux you can use Docker Engine directly. |
| Jest, Supertest, k6, ESLint, Prometheus format | Open source; k6 runs locally. |
| Mock providers (`MOCK_PROVIDER_ENABLED=true`) | In-process, no network, no keys: exercises caching, rate limits, fallback, circuit breaker, streaming, dashboard. |
| Built-in `hash` embedder | No dependencies. |
| `transformers` embedder (optional) | Free software; downloads a ~90 MB model once and uses local CPU/disk. |

## What may cost money
| Item | Guidance |
|---|---|
| **Real LLM providers** (Groq, Gemini, OpenRouter) | **Optional.** Keys are only needed if you enable them. Many offer free tiers or free models, but limits, eligibility and prices change — check each provider's current pricing page; never assume. Paid usage is possible if you exceed a free allowance or choose paid models. |
| GitHub Actions | Free for public repositories; private repositories get a limited free allowance that can change. The CI is optional to the project. |
| **AWS (or any cloud)** | **Optional and not required.** See `AWS_DEPLOYMENT.md`: free-tier eligibility is not assumed, and the document lists the resources that can generate charges (EC2, EBS, public IPv4 addresses, RDS, load balancers, NAT gateways, ECR, CloudWatch, data transfer) and how to delete them. |
| Domain name, TLS certificates | Not needed locally; certificates can be free (e.g. Let's Encrypt), domains are not. |

## Keeping real-provider spend bounded (if you use real keys)
* Give each app its own **tenant with a small `monthly_token_budget`** and a conservative rate limit; the gateway returns `429` instead of spending past the budget.
* Keep caching on: hits cost nothing. `GET /api/cache/stats` and the dashboard show estimated savings.
* Maintain `config/pricing.json` with **current** prices from the provider's pricing page (it ships without real prices on purpose). Costs are estimates; unknown prices produce `null`, not a guess.
* Set billing alerts at the provider/cloud level — the gateway's budget is a guard-rail, not a billing system (token counts may be approximate when providers report no usage).

## Cost model the gateway reports
`estimated_cost = (input_tokens × price_in + output_tokens × price_out) / 1,000,000`, per provider/model price from `pricing.json` (`<provider>:<model>` then `*:<model>`).
Cache hits record `cost = 0` and an `estimated_savings` equal to what the cached entry's original usage would have cost. Provider pricing changes over time, so historical estimates use whatever the file said when the request ran.

## Reproducing the cost-savings benchmark for free
Run `docs/LOAD_TESTING.md` Benchmark 3 against `scripts/mock-upstream.js` or the mock providers with the illustrative mock price: the arithmetic is real, the dollar figures are not. Real figures need real prices and (optionally) a real provider.
