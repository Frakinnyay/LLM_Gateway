# Using the gateway from existing apps (FinRAG, FinAgent, FinTune, …)

Anything that speaks the OpenAI chat-completions API can point at the gateway by changing the base URL and key. **This repository does not modify your other projects**; these are examples to copy.

## 1. Create a tenant and key
```bash
docker compose run --rm gateway node dist/scripts/create-tenant.js finrag 5000000   # name, monthly token budget
# or, from source:  npm run create-tenant -- finrag 5000000
```
Use one tenant per application: separate budgets, rate limits, cache isolation and usage reporting. The key is shown once.

## 2. Point the app at the gateway (`http://localhost:<gateway-port>/v1`)

Environment variables (works with the official OpenAI SDKs and many frameworks):
```bash
export OPENAI_BASE_URL=http://localhost:8080/v1
export OPENAI_API_KEY=lgw_xxxxxxxx_yyyyyyyy...
```
Python:
```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8080/v1", api_key=os.environ["LLM_GATEWAY_API_KEY"])
r = client.chat.completions.create(
    model="llama-3.3-70b-versatile",            # must be a model ID a configured provider serves (GET /v1/models)
    messages=[{"role": "user", "content": "Summarise this filing."}],
    temperature=0.2,
)
print(r.choices[0].message.content)
```
LangChain (Python):
```python
from langchain_openai import ChatOpenAI
llm = ChatOpenAI(base_url="http://localhost:8080/v1", api_key=os.environ["LLM_GATEWAY_API_KEY"], model="llama-3.3-70b-versatile")
```
Node:
```ts
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://localhost:8080/v1", apiKey: process.env.LLM_GATEWAY_API_KEY });
```
Opt a call out of caching when you need a fresh sample (evaluation, agents): `extra_headers={"Cache-Control": "no-cache"}` (Python SDK) or `defaultHeaders`/per-request headers (Node).

Inside Docker, use the service name instead of `localhost` (e.g. `http://gateway:8080/v1`) on the same compose network.

## 3. What will and will not work today
| Feature | Status |
|---|---|
| Chat completions (JSON and streaming), `temperature`, `top_p`, `max_tokens`, `stop` | Supported |
| `GET /v1/models` | Supported (enabled providers' models) |
| **Embeddings (`/v1/embeddings`)** | **Not implemented.** A RAG pipeline (e.g. FinRAG) must keep calling its embedding provider directly; only its chat/generation calls can go through the gateway. |
| **Tool / function calling, JSON mode (`response_format`)** | **Not implemented — requests containing them get `400 INVALID_REQUEST`** so agents (e.g. FinAgent) fail loudly instead of silently receiving plain text. |
| Vision/multimodal content, `n > 1`, legacy `/v1/completions` | Not supported |
| Model names | Must match a model ID configured in `*_MODELS`; fallback only between providers listing the same ID |

## 4. Behaviours your client should expect
* **429 with `Retry-After`** (rate limit) and **429 `TOKEN_BUDGET_EXCEEDED`** (budget). The SDKs' built-in retry honours `Retry-After`; budget errors will not succeed on retry.
* **Caching:** identical requests return `X-Cache: HIT` (no cost). With `temperature > 0` a hit is a previously sampled answer.
* **Streaming usage is estimated** (the response has no `usage`); non-stream `usage` is the provider's when reported.
* Check `X-Provider`/`X-Fallback-Used` to see which provider answered; quote `X-Request-ID` (also in every error body) when debugging.
* Fine-tuning workloads (FinTune) that call training/finetune APIs are out of scope; only inference-style chat calls apply.

## 5. Verify the integration
`GET /api/requests` or the dashboard shows each call with provider, tokens, latency, cache status and estimated cost; `GET /api/usage?tenant_id=…` shows monthly consumption against the budget.
