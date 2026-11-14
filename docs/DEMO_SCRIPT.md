# Demo script (zero cost, mock providers only)

Everything below works with the built-in mock providers (`mock`, `mock-2`, model `mock-model`) — no API keys, no spend.
Commands are bash/curl; on Windows use WSL/Git Bash or run the same requests from the dashboard's **Try it** panel.

## Setup
```bash
npm run setup                                   # .env with random secrets
# optional, makes Demo 4/6 quicker: edit .env ->  RATE_LIMIT_CAPACITY=5  RATE_LIMIT_REFILL_PER_SEC=0.2  CB_COOLDOWN_MS=5000
docker compose up --build -d
export ADMIN=$(grep ^ADMIN_API_TOKEN .env | cut -d= -f2)
docker compose run --rm gateway node dist/scripts/create-tenant.js demo 1000000    # prints api_key once
export KEY=lgw_...                              # paste it
export BASE=http://localhost:8080
chat() { curl -si $BASE/v1/chat/completions -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" "${@:2}" -d "$1" | grep -iE "^HTTP|^x-|^retry-after|^\{|^data:" ; }
```
Open the dashboard at http://localhost:8081 (sign in with `$ADMIN`) and keep it visible: request rows appear about a second after each call.

## Demo 1 — normal request
```bash
chat '{"model":"mock-model","messages":[{"role":"user","content":"Explain vector databases."}]}'
```
Show: `200`, `X-Provider: mock`, `X-Cache: MISS`, an OpenAI-style body, an `X-Request-ID`.

## Demo 2 — same request again → cache hit
```bash
chat '{"model":"mock-model","messages":[{"role":"user","content":"Explain vector databases."}]}'
```
Show: `X-Cache: HIT`, `X-Cache-Type: exact`, identical body, dashboard row with cost `$0` and a saving. The provider was not called (tokens/budget unchanged).

## Demo 3 — paraphrase → semantic cache (and the threshold trade-off)
Requires `SEMANTIC_CACHE_ENABLED=true` (the `.env.example` default). The built-in embedder is **lexical**, so "paraphrase" here means same words, different casing/punctuation; real paraphrase matching needs `EMBEDDING_PROVIDER=transformers`.
```bash
chat '{"model":"mock-model","messages":[{"role":"user","content":"explain vector databases"}]}'      # similarity 1.0000 -> semantic HIT
chat '{"model":"mock-model","messages":[{"role":"user","content":"Please explain vector databases."}]}' # 0.8740 -> MISS at threshold 0.92
```
Show `X-Cache-Type: semantic` + `X-Semantic-Similarity: 1.0000` for the first, and `X-Cache: MISS` with `X-Semantic-Similarity: 0.8740` for the second (values measured with this embedder in the authoring sandbox).
Then set `SEMANTIC_CACHE_THRESHOLD=0.85`, `docker compose up -d gateway`, and repeat a *new* variant of the "Please explain…" prompt after seeding the original: it now hits — more hits, more risk of a wrong answer. A different topic ("Explain relational databases." ≈ 0.55) still misses.

## Demo 4 — rate limit exceeded
(With `RATE_LIMIT_CAPACITY=5`, `RATE_LIMIT_REFILL_PER_SEC=0.2`.)
```bash
for i in 1 2 3 4 5 6 7; do chat "{\"model\":\"mock-model\",\"messages\":[{\"role\":\"user\",\"content\":\"burst $i\"}]}" | head -1; done
```
Show five `200`s then `429` with `Retry-After`, body `RATE_LIMIT_EXCEEDED`, and `gateway_rate_limit_rejections_total` in `/metrics`. Wait ~5 s and a request succeeds again (refill).

## Demo 5 — disable the primary → fallback
```bash
curl -s -X POST $BASE/api/providers/mock/disable -H "Authorization: Bearer $ADMIN"
chat '{"model":"mock-model","messages":[{"role":"user","content":"failover please"}]}' -H "Cache-Control: no-cache"
```
Show `X-Provider: mock-2` and `X-Fallback-Used: true`; the dashboard card shows **Disabled** and the row has a *fallback* badge (use the card's Disable/Enable button live). Re-enable: `POST /api/providers/mock/enable`.
Narrate it as: primary unavailable → fallback succeeded.

## Demo 6 — circuit breaker: CLOSED → OPEN → HALF_OPEN → CLOSED
```bash
state() { curl -s $BASE/api/providers -H "Authorization: Bearer $ADMIN" | python3 -c "import sys,json;[print(p['name'],p['circuit']['state'],p['circuit']['consecutiveFailures']) for p in json.load(sys.stdin)['data']]"; }
curl -s -X POST $BASE/api/providers/mock/failure-mode -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -d '{"mode":"http_503"}'
for i in 1 2 3 4; do chat "{\"model\":\"mock-model\",\"messages\":[{\"role\":\"user\",\"content\":\"fail $i\"}]}" -H "Cache-Control: no-cache" | grep -iE "^HTTP|x-provider|x-fallback"; state; done
```
Every request still returns `200` (served by `mock-2`) while `mock` accumulates failures: **CLOSED → OPEN** after the threshold (default 5 consecutive failures, counting retries — about three requests). `state` shows `OPEN`; the dashboard card turns **Circuit Open** with a retry countdown, and `gateway_circuit_breaker_state{provider="mock"} 2`.
Recovery:
```bash
curl -s -X POST $BASE/api/providers/mock/failure-mode -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -d '{"mode":"none"}'
sleep 6      # CB_COOLDOWN_MS (5 s if you lowered it; default 30 s)
chat '{"model":"mock-model","messages":[{"role":"user","content":"probe"}]}' -H "Cache-Control: no-cache" | grep -iE "x-provider"; state
```
The first request after the cooldown is the **HALF_OPEN** probe; it succeeds on `mock`, and `state` reads **CLOSED** again (OPEN → HALF_OPEN → CLOSED). `docker compose logs gateway` shows each transition as a `provider event`.

## Demo 7 — streaming
```bash
curl -N $BASE/v1/chat/completions -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"mock-model","stream":true,"messages":[{"role":"user","content":"stream this answer to me word by word"}]}'
```
Show chunks arriving incrementally and a final `data: [DONE]`. Mid-stream failure: set `{"mode":"stream_cut"}` on `mock`, repeat — the stream ends with an in-band `error` event and **no** `[DONE]` (it cannot switch providers after bytes were sent). Reset with `{"mode":"none"}`.

## Demo 8 — dashboard and metrics
Show the dashboard (provider cards, cache stats with hit rate, cost chart with spent vs saved, request table with cache/fallback badges) and:
```bash
curl -s $BASE/metrics | grep -E "^gateway_(requests_total|cache_hits_total|cache_misses_total|fallback_total|provider_failures_total|circuit_breaker_state)"
```
Point out that labels are bounded (no tenant/key/request IDs) and that costs are *estimates* from `config/pricing.json` (the mock price is illustrative).

## Cleanup
`docker compose down -v` (removes the database volume).
