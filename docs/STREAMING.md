# Streaming (Server-Sent Events)

`"stream": true` returns `text/event-stream`. Chunks are **forwarded as they arrive** from the provider; the gateway never waits for the full answer and then replays it
(except for cache hits, which are replayed because the answer already exists).

## Wire format
```text
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no

data: {"id":"…","object":"chat.completion.chunk","model":"…","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"…":"…","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"…":"…","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```
Try it: `curl -N http://localhost:8080/v1/chat/completions -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"model":"mock-model","stream":true,"messages":[{"role":"user","content":"hi"}]}'`

## Flow
1. Auth, validation, rate limit, caches and budget reservation happen **before** any byte is sent (so these failures are ordinary JSON errors with the right HTTP status).
2. `ProviderManager.openStream()` selects a provider and waits for its **first chunk**. Failures up to this point (including timeouts) still trigger retry/fallback and, if all fail, a normal JSON error.
3. Only then are SSE headers sent. Each provider chunk is normalised and written with backpressure handling (`write()` returning false waits for `drain` or `close`).
4. When the provider finishes: `data: [DONE]`, settle token usage, populate both caches with the assembled answer.

## Failure behaviour

| Situation | Behaviour |
|---|---|
| Provider fails **before** the first chunk | Retry / fall back / JSON error — as for non-streaming. |
| Provider fails **after** chunks were sent | Cannot change the HTTP status and cannot switch providers (that would splice two different generations). The gateway writes `data: {"error":{…,"request_id":…}}` and ends the stream **without** `[DONE]`, so a client can tell it was truncated. The failure counts against the breaker; tokens produced so far are charged. |
| Client disconnects | The upstream request is aborted, the generator is closed, the budget reservation is settled with what was produced, and the breaker is **not** penalised. |
| Provider goes silent | `STREAM_IDLE_TIMEOUT_MS` (max gap between chunks; armed only while the gateway waits on the provider, not while a slow client reads) → timeout error. |
| Stream runs too long | `STREAM_MAX_DURATION_MS` hard cap. |
| Provider timeout before first chunk | `PROVIDER_TIMEOUT_MS` (time to first chunk). |
| Upstream SSE oddities | A parser handles chunk boundaries splitting lines or UTF-8 sequences, CRLF/LF/CR, comments, multi-line data and caps line length; a stream that ends with neither `[DONE]` nor a finish reason is treated as a failure. |

## Usage and cost
Providers rarely send token usage on streams. By default the gateway **estimates** usage from the streamed text (flagged `tokens_estimated`). `STREAM_INCLUDE_USAGE=true` asks
upstream for a usage chunk (OpenAI `stream_options`) — off by default because not every provider accepts it (unverified against the real providers).

## Proxies
Reverse proxies must not buffer SSE. The bundled nginx config sets `proxy_buffering off`, HTTP/1.1 to the upstream and a 330 s read timeout; `X-Accel-Buffering: no` is also sent.

## Not done
No SSE heartbeat/keep-alive comments (the idle timeout bounds silent streams instead); no `Last-Event-ID` resumption.
