# Beginner's step-by-step guide: from ZIP file to a finished, running project

This guide assumes **you have never run a project like this before**. Follow the parts in order. Every part says what you are doing, why, the exact commands, what you should see, and what to do if it goes wrong.

> **Honest expectation setting.** The code in this ZIP was written and partly tested in an environment that had no internet, no database and no Docker. Some of it has **never been run**. So when you run it for the first time, **a few errors are normal** (typing errors, a failing test, a Docker hiccup). That is not you doing something wrong. Part 5 and Part 17 explain exactly how to handle that. Do not skip the checks and jump straight to Docker — fixing problems early, one at a time, is much easier.

**Contents**
0. What you are building (2 minutes)
1. Install the tools
2. Unpack the project and open it
3. Learn the 6 terminal commands you need
4. Install the project's dependencies
5. Check that the code is healthy (typecheck, lint, unit tests)
6. Start the database and Redis
7. Run the integration tests
8. Run the gateway and send your first request
9. Open the dashboard
10. Try every feature (the demo)
11. Run the whole thing in Docker
12. (Optional) Use real AI providers
13. (Optional) Better semantic cache
14. Measure it: benchmarks
15. Put it on GitHub
16. Finish: fill in your real results
17. When something goes wrong
18. Use it from your other projects
19. What to build next (optional improvements)
20. Glossary and "am I done?" checklist

---

## Part 0 — What you are building

Imagine a **receptionist** standing between your apps and AI companies (Groq, Gemini, OpenRouter):

* It checks who is calling (**API key**), stops people calling too often (**rate limit**) or spending too much (**token budget**).
* It remembers answers (**cache**) so you don't pay twice for the same question.
* If one AI company is down it can try another (**fallback**) and stops calling a broken one (**circuit breaker**).
* It records everything (**logs, metrics, dashboard**).

It also ships with **fake "mock" AI providers**, so you can try everything **without paying for anything and without any API keys**.

The pieces you will run:

| Piece | What it is | Where it runs |
|---|---|---|
| **Gateway** | The receptionist (a Node.js program) | `http://localhost:8080` |
| **PostgreSQL** | Database (stores users' keys, usage, logs) | Docker container |
| **Redis** | Fast memory store (rate limits, quick cache) | Docker container |
| **Dashboard** | A web page to watch and control it | `http://localhost:5173` (dev) or `:8081` (Docker) |

**"localhost"** simply means "this computer".

---

## Part 1 — Install the tools

You need four things. All are free.

| Tool | Why | Download |
|---|---|---|
| **Node.js 22 (LTS)** | Runs the project's code. Version 20 or higher works. | https://nodejs.org (choose "LTS") |
| **Git** | Saves your work and uploads it to GitHub. | https://git-scm.com/downloads |
| **Docker Desktop** | Runs the database and Redis (and later the whole project) in "containers". | https://www.docker.com/products/docker-desktop |
| **VS Code** | A friendly editor to look at and edit files. | https://code.visualstudio.com |

### Windows notes
* Install Docker Desktop with the **WSL 2** option ticked (the installer suggests it). If Docker says "virtualization is disabled", you must turn on *Virtualization* (Intel VT-x / AMD-V) in your computer's BIOS — search your laptop model + "enable virtualization".
* Restart your computer after installing Docker Desktop, then **open Docker Desktop and wait until it says it is running** (a whale icon in the system tray). Docker must be running whenever you use the commands in this guide.
* Docker Desktop has its own licence terms (free for personal use and small businesses at the time of writing). Check the current terms on Docker's website.

### Check your installs
Open a terminal:
* **Windows:** press the Windows key, type `PowerShell`, open **Windows PowerShell** (or "Terminal").
* **macOS:** open **Terminal**. **Linux:** open your terminal app.

Type each command, press **Enter**, and compare:

```bash
node --version        # should print v20.x or v22.x (higher is OK)
npm --version         # prints a number like 10.x
git --version         # prints git version 2.x
docker --version      # prints Docker version 2x.x
docker compose version   # prints Docker Compose version v2.x
```

**If a command says "not recognized" / "command not found":** close and reopen the terminal (installers update your PATH only for new terminals). Still failing? Reinstall that tool.
**If `node --version` is lower than v20:** install the newer Node.js from nodejs.org.

---

## Part 2 — Unpack the project and open it

1. Put `LLM-Gateway.zip` somewhere easy, e.g. `Documents`.
2. **Extract it:** Windows — right-click → *Extract All…*; macOS — double-click; Linux — `unzip LLM-Gateway.zip`.
   You get a folder named `llm-gateway`.
3. Open VS Code → **File → Open Folder…** → choose the `llm-gateway` folder (the one that directly contains `package.json` and `README.md`).
4. Open VS Code's built-in terminal: **Terminal → New Terminal** (or press <kbd>Ctrl</kbd>+<kbd>`</kbd>).
   From now on, **every command in this guide is typed in this terminal**, which is already "inside" the project folder.

Check you are in the right place:

```bash
# Windows PowerShell:     dir        macOS/Linux:   ls
```
You should see `package.json`, `README.md`, `docs`, `apps`, `packages`, … If not, you're in the wrong folder: use `cd` to go into `llm-gateway`.

> **Tip:** the folder structure is explained in `docs/ARCHITECTURE.md`. You don't need to understand it yet.

---

## Part 3 — Learn the 6 terminal commands you need

| Command | Meaning |
|---|---|
| `cd folder` | Go into a folder. `cd ..` goes up one. |
| `dir` (Windows) / `ls` (Mac/Linux) | List files in the current folder. |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> | **Stop** a running program (the gateway keeps running until you press this). |
| <kbd>↑</kbd> (up arrow) | Recall your previous command. |
| `npm run something` | Run one of the project's named tasks (listed in `package.json`). |
| `docker compose ...` | Control the containers. |

A program that "keeps running" (like the gateway) **occupies that terminal**. To run a second thing, open a **new terminal** in VS Code with the **+** button in the terminal panel.

---

## Part 4 — Install the project's dependencies

The project uses many free libraries (Express, Jest, React…). `npm install` downloads them into a folder called `node_modules`. This needs internet.

```bash
npm install
```

* Takes a few minutes. Lots of text scrolls past — that's normal.
* **What you should see at the end:** something like `added NNN packages` and maybe warnings about "deprecated" packages (ignore) and "vulnerabilities" (see below).
* **A new file appears: `package-lock.json`.** This records the exact versions installed. **Keep it and commit it later** (Part 15) — the Docker build and GitHub CI use it.

**If you see `npm ERR! code ERESOLVE`:** run `npm install --legacy-peer-deps` and tell your assistant the full error afterwards.
**If you see `EACCES` / permission errors (macOS/Linux):** do not use `sudo`; fix npm permissions (search "npm fix EACCES permissions") or use Node via `nvm`.
**If it hangs or fails on network errors:** check your internet/VPN/proxy and retry.

**About "vulnerabilities" messages:** later, run `npm audit` and read the report (Part 19). Don't run `npm audit fix --force` blindly — it can break things.

Create your settings file with **random secrets** (this protects your keys):

```bash
npm run setup
```
You should see: `Wrote .env with new API_KEY_PEPPER and ADMIN_API_TOKEN ...`. This creates a file named **`.env`** — your private settings. **Never share it, never commit it** (it's already in `.gitignore`).
If it says `.env already exists`, that's fine — it won't overwrite it.

---

## Part 5 — Check that the code is healthy

Run these three checks, **one at a time**, and fix problems before moving on.

### 5a. Typecheck (does the TypeScript code make sense?)

```bash
npm run typecheck
npm run typecheck -w apps/dashboard
```

* **Success:** the command finishes with no red "error TS…" lines.
* **Failure:** you'll see lines like `apps/gateway/src/routes/chat.ts(54,13): error TS2339: ...`. This means: file, (line, column), error code, explanation.
  * Because this code has never been compiled with all libraries present, **a handful of errors is possible**. It's normal and fixable.
  * Look at the **first** error only — later ones are often caused by the first.
  * Fix it yourself if the message is obvious, or ask for help using the template in Part 17.

### 5b. Lint (code-style police)

```bash
npm run lint
```
* **Success:** no output (or only warnings).
* **Failure:** messages like `error  'x' is defined but never used  @typescript-eslint/no-unused-vars`. Fix the line, or ask for help. Some can be auto-fixed: `npx eslint . --fix`.

### 5c. Unit tests (fast tests, no database needed)

```bash
npm test
```
* **Success:** a summary like `Test Suites: 12 passed` and `Tests: ... passed`.
* The suites for `config` and `schemas` have **never been run before**, so if any test fails there, that's useful information — tell your assistant the failing test name and message.

**Do not move to Part 6 until `typecheck`, `lint` and `npm test` are all green** (or you've decided consciously to postpone a specific failure).

---

## Part 6 — Start the database and Redis

Make sure Docker Desktop is **running**. Then:

```bash
npm run infra:up
```
This starts **PostgreSQL (with the pgvector add-on)** and **Redis** in containers. The first time it downloads images (a few hundred MB) — be patient.

Check they are healthy:

```bash
docker compose -f docker-compose.dev.yml ps
```
You should see two services (`postgres`, `redis`) with status **running** and, after ~10–20 seconds, **(healthy)**.

Create the database tables (called "migrations"):

```bash
npm run migrate
```
You should see: `Applied: 001_init.sql, 002_usage_reservations.sql, 003_savings_column.sql`. (Running it again says `No pending migrations` — that's correct.)

**Troubleshooting**
* `port is already allocated` (5432 or 6379): another Postgres/Redis is already running on your computer. Stop it, or in Docker Desktop stop old containers, then retry.
* `Cannot connect to the Docker daemon` / `docker: error during connect`: Docker Desktop isn't running — start it and wait for the whale icon.
* `extension "vector" is not available`: you're not using the project's database container. Run `npm run infra:down`, then `npm run infra:up` again.
* Migration `ECONNREFUSED`: the database isn't ready yet — wait 15 seconds and retry.

---

## Part 7 — Run the integration tests

These are the tests that need the **real** database and Redis. They prove the tricky parts (rate limiting, token budget, caches, fallback, streaming) really work. They have **never been executed** — so this is an important step.

```bash
npm run test:integration
```
* Takes a minute or two. Each test file creates a private temporary database schema and uses Redis database number 15, so **your real data is never touched**.
* **Success:** all suites pass.
* **Failures:** expect possibly a few on the first run. Read the first failing test's message:
  * "connect ECONNREFUSED" → database/Redis isn't running (Part 6).
  * A test about timing (refill/TTL/streaming) failing once → run it again; if it keeps failing, report it.
  * A real logic failure → copy the test name and message to your assistant (Part 17). This is exactly why we test.

---

## Part 8 — Run the gateway and send your first request

### 8a. Start the gateway

```bash
npm run dev
```
**What you should see:** a JSON log line containing `"msg":"gateway listening"` and `"port":8080`. The terminal now stays busy — **leave it running**.

**Quick check:** open a web browser and go to http://localhost:8080/health → you should see `{"status":"ok"}`. And http://localhost:8080/ready → `{"status":"ready","checks":{"postgres":true,"redis":true}}`.

**If the gateway exits immediately with `Invalid configuration:`** the message tells you exactly which setting is wrong (usually `.env` missing → run `npm run setup`).

### 8b. Create a tenant and an API key

Open a **second terminal** (the **+** button), and run:

```bash
npm run create-tenant -- demo
```
You'll see:
```
tenant_id: 3f2a...
api_key:   lgw_ab12cd34_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
(store this key now; it cannot be shown again)
```
**Copy the `api_key` into a notes file now.** It's shown only once. (If you lose it, just create another tenant.)

### 8c. Send your first AI request (to the fake "mock" AI — free)

**Windows PowerShell:**
```powershell
$KEY = "lgw_paste_your_key_here"
$body = '{"model":"mock-model","messages":[{"role":"user","content":"Explain vector databases."}]}'
$r = Invoke-WebRequest -Uri http://localhost:8080/v1/chat/completions -Method POST `
     -Headers @{ Authorization = "Bearer $KEY" } -ContentType "application/json" -Body $body
$r.Headers["X-Cache"]      # MISS  (first time)
$r.Headers["X-Provider"]   # mock
$r.Content                 # the AI-style answer (JSON)
```
**macOS / Linux / Git Bash:**
```bash
KEY="lgw_paste_your_key_here"
curl -si http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"mock-model","messages":[{"role":"user","content":"Explain vector databases."}]}'
```
**What you should see:** `200`, a JSON answer like `"content":"[mock] You said: Explain vector databases."`, and headers `X-Cache: MISS`, `X-Provider: mock`.

**Now run the exact same command again** → `X-Cache: HIT` and `X-Cache-Type: exact`. 🎉 That's the cache working: no AI call was made.

> If PowerShell's multi-line backtick (`` ` ``) confuses you, put the `Invoke-WebRequest` command on one line. If you'd rather not type commands at all, use the dashboard's **"Try it"** panel (Part 9) — it does the same thing with buttons.

**Common first-request errors**
| You see | Meaning / fix |
|---|---|
| `401 INVALID_API_KEY` | Wrong/missing key. Re-copy it. Keys start with `lgw_`. |
| `404 MODEL_NOT_FOUND` | Model name wrong. Use exactly `mock-model`. |
| `503` or connection refused | Gateway not running — check the first terminal. |

---

## Part 9 — Open the dashboard

In a **third terminal**:

```bash
npm run dev:dashboard
```
Open http://localhost:5173. You'll see a sign-in box:
1. Open the `.env` file in VS Code, find the line `ADMIN_API_TOKEN=...`, copy the long value after `=`.
2. Paste it into the dashboard → **Sign in**.

You should see: **Providers** (`mock` and `mock-2`, both Healthy), **Cache** stats, a **cost chart**, a **Recent requests** table (it shows the two requests you just sent — wait ~3 seconds), and a **Try it** panel (paste your `lgw_…` key there to send requests with buttons).

> The dashboard forgets the token if you refresh the page. That's a deliberate security choice.

---

## Part 10 — Try every feature (the demo)

Use the **Try it** panel and the provider cards, or the commands in `docs/DEMO_SCRIPT.md`. Here is the beginner path:

1. **Cache hit:** send the same prompt twice in *Try it* → second shows `x-cache: HIT`.
2. **Semantic cache:** send `Explain vector databases.`, then `explain vector databases` (different capitalisation/punctuation) → `x-cache-type: semantic`.
   *Why does it match?* The built-in matcher compares words, not meaning, so only near-identical wording matches (see Part 13 for a smarter one).
3. **Failover:** on the **mock** provider card click **Disable**. Tick **bypass cache** and send a request → `x-provider: mock-2` and `x-fallback-used: true`. Click **Enable** again.
4. **Circuit breaker:** on the **mock** card choose Failure mode **http_503**. Send 4 requests (bypass cache ticked). All succeed (served by `mock-2`) while `mock` collects failures; its card turns **Circuit Open**. Set the failure mode back to **none**, wait ~30 seconds, send another request → the breaker tries `mock` again and goes back to **Healthy**. (To make this faster, put `CB_COOLDOWN_MS=5000` in `.env`, then restart the gateway: <kbd>Ctrl</kbd>+<kbd>C</kbd> in the gateway terminal, `npm run dev`.)
5. **Streaming:** tick **stream** and send → text appears progressively.
6. **Rate limit:** in `.env` set `RATE_LIMIT_CAPACITY=3` and `RATE_LIMIT_REFILL_PER_SEC=0.1`, restart the gateway, send 5 quick requests → the 4th gets `429 RATE_LIMIT_EXCEEDED` with `Retry-After`. **Set the values back** (60 and 1) afterwards.
7. **Metrics:** open http://localhost:8080/metrics and look for lines starting with `gateway_`.

---

## Part 11 — Run the whole thing in Docker

Until now you ran the gateway "from source". Docker runs **everything** (database, Redis, gateway, dashboard) as one package — this is the "canonical" way to run it.

1. **Stop** the dev gateway and dashboard (<kbd>Ctrl</kbd>+<kbd>C</kbd> in their terminals) and free the ports:
   ```bash
   npm run infra:down
   ```
2. Make sure `.env` exists (`npm run setup` if not).
3. Build and start:
   ```bash
   docker compose up --build
   ```
   * The first build takes several minutes (it downloads and compiles things). Lots of output is normal.
   * **Done when** you see the gateway log `gateway listening` and no repeated errors.
4. Open the dashboard: **http://localhost:8081** (sign in with `ADMIN_API_TOKEN`). The gateway is at http://localhost:8080.
5. Create a tenant key (in a **new terminal**):
   ```bash
   docker compose run --rm gateway node dist/scripts/create-tenant.js demo
   ```
6. Run the automatic end-to-end check:
   ```bash
   npm run smoke
   ```
   You should see 12 `PASS` lines and `SMOKE TEST PASSED`.
7. Stop everything: <kbd>Ctrl</kbd>+<kbd>C</kbd>, then `docker compose down`. To also **delete the data**: `docker compose down -v`.

**If the Docker build fails** (this has never been run, so it can happen):
* Scroll up to the **first** red error. Typical causes: a TypeScript error in the dashboard (`tsc` runs during the build) → you should have caught it in Part 5; `npm ci` complaining about the lockfile → run `npm install` again and retry; no internet.
* `variable is not set: run npm run setup` → you have no `.env`.
* `port is already allocated` → run `npm run infra:down` and close anything using 8080/8081/5432/6379.
* Send the error text to your assistant (Part 17).

---

## Part 12 — (Optional) Use real AI providers

You can skip this part entirely and still have a complete project. If you want real answers:

### 12a. Get free API keys (sign-ups, free tiers change — check each site)
* **Groq:** https://console.groq.com → API Keys
* **Google Gemini:** https://aistudio.google.com → "Get API key"
* **OpenRouter:** https://openrouter.ai → Keys

**Never paste keys into chat, screenshots, or GitHub.** They go only in `.env`.
Free tiers have limits and can change; going over might cost money. Use a **small token budget** on your tenant (Part 8b: `npm run create-tenant -- demo 100000`).

### 12b. Put the key in `.env`
Example for Groq (edit with VS Code):
```
GROQ_ENABLED=true
GROQ_API_KEY=your_key_here
GROQ_MODELS=llama-3.3-70b-versatile
```
**Check the model name** on Groq's model list — names change. Then restart the gateway and ask for that model:
```json
{"model":"llama-3.3-70b-versatile","messages":[{"role":"user","content":"Say hello"}]}
```
Check `GET /v1/models` (or the dashboard) to see which model names the gateway currently offers.

### 12c. Prices (for the cost chart)
Open `config/pricing.json`. For each real model add a line using the price from the provider's pricing page:
```json
"groq:llama-3.3-70b-versatile": { "input": 0.00, "output": 0.00 }
```
(units: US dollars per 1,000,000 tokens — put the **real current** numbers). Without a price the dashboard shows "—" for cost instead of guessing.

### 12d. Important limitation (read this)
The gateway passes the model name **unchanged** to the provider. Different companies name models differently, so **automatic failover from Groq to OpenRouter is not really possible yet** — the second provider wouldn't recognise the first one's model name. Failover is fully demonstrable with the mock providers. Building a *model alias* feature is the top recommended improvement (Part 19).

---

## Part 13 — (Optional) A smarter semantic cache

The default "hash" matcher only recognises near-identical wording. For real paraphrase matching:

```bash
npm install @xenova/transformers
```
In `.env`: `EMBEDDING_PROVIDER=transformers`. Restart the gateway. The **first** request downloads a ~90 MB model (free, one time) and uses your CPU.
This path has never been run — if it errors, switch back to `EMBEDDING_PROVIDER=hash`.

**Tuning the threshold** (`SEMANTIC_CACHE_THRESHOLD`, default 0.92): lower = more cache hits but riskier wrong answers. To choose a value with evidence: write pairs of prompts in a text file `pairs.jsonl` (see `load-tests/data/semantic_pairs.example.jsonl` for the format) and run:
```bash
npm run threshold-sweep -- pairs.jsonl
```
It prints precision/recall for each threshold. Pick the lowest threshold whose precision stays very high.

---

## Part 14 — Measure it: benchmarks

These give you **real numbers** for your résumé. Never invent them — the whole point is that they're yours.

### Setup (once)
1. Install **k6** (free): Windows `winget install k6` (or download from https://grafana.com/docs/k6/latest/set-up/install-k6/), macOS `brew install k6`, Linux see the same page. Check: `k6 version`.
2. Run the Docker stack (Part 11) **or** `npm run dev` with infra up.
3. For load tests, relax the limits in `.env`: `RATE_LIMIT_CAPACITY=100000` and `RATE_LIMIT_REFILL_PER_SEC=100000`, then restart. Create a tenant with a **big budget**: `npm run create-tenant -- bench 1000000000`.

### Benchmark 1 — cache hit rate
```bash
node scripts/gen-cache-dataset.js 500 1 > load-tests/data/cache_workload.json
k6 run -e API_KEY=lgw_your_bench_key -e ADMIN_TOKEN=your_admin_token load-tests/cache.js
```
Results are printed and saved in `load-tests/results/`. Run it on a **fresh** tenant each time (new `create-tenant`) and clear the cache first, otherwise earlier runs inflate the numbers: `docker compose exec redis redis-cli FLUSHDB` (Docker) .

### Benchmark 4 — failover / recovery (free with mock providers)
```bash
k6 run -e API_KEY=lgw_your_bench_key -e ADMIN_TOKEN=your_admin_token -e FAULT=http_503 load-tests/fallback.js
```

### Benchmark 2 — gateway overhead and Benchmark 3 — cost savings
Follow `docs/LOAD_TESTING.md` exactly (it needs the small fake upstream `scripts/mock-upstream.js` and a few `.env` changes). Run each test at least 3 times and write down the middle result.

### Record your results
Write them in a notes file as you go: date, your computer (CPU/RAM), the command, the output. You'll need them in Part 16.

---

## Part 15 — Put it on GitHub

1. Create a free account at https://github.com.
2. Click **New repository** → name it `llm-gateway` → **do not** tick "Add a README" → Create.
3. Tell Git who you are (once per computer):
   ```bash
   git config --global user.name "Your Name"
   git config --global user.email "you@example.com"
   ```
4. In the project terminal:
   ```bash
   git init
   git add -A
   git status
   ```
   **Check the list:** `.env` and `node_modules` must **not** appear. (You can also run `git check-ignore -v .env` — it should print a matching `.gitignore` line.) `package-lock.json` **should** appear.
5. Add a licence file (e.g. MIT): on GitHub after the first push, **Add file → Create new file → name it `LICENSE`** and use the "Choose a license template" button; or paste the MIT text yourself.
6. Commit and push (use the exact commands GitHub shows on the empty repo's page):
   ```bash
   git commit -m "Initial commit: LLM Gateway"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/llm-gateway.git
   git push -u origin main
   ```
   GitHub asks you to sign in (a browser window or a *personal access token* in place of the password).
7. Open the **Actions** tab on GitHub. The CI workflow starts automatically. **It has never run**, so the first run may fail; click the failed job, read the first red step, fix, commit, push again. Green ✅ only counts once you've actually seen it.

> **Danger check:** if you ever accidentally commit `.env`, **assume the secrets are leaked**: delete `.env`, run `npm run setup` again (new secrets), and remove the file from Git history. Also revoke any provider keys that were inside.

---

## Part 16 — Finish: fill in your real results

1. **README.md → section 14 table:** replace each `TBD` with the number you measured (add the conditions).
2. **docs/RESUME_BULLETS.md:** replace `[X]`, `[Y]`, `[N]`, `[Z]` with your numbers, and **delete any bullet you can't back up**.
3. **docs/PORTFOLIO_DESCRIPTION.md:** fill the results table.
4. **README.md → section 19 (verification status):** change "UNVERIFIED" to "VERIFIED" only for things you actually ran, and say what you ran. This honesty is what makes the project credible.
5. Commit and push again.

---

## Part 17 — When something goes wrong

**Golden rules**
1. Read the **first** error, not the last.
2. One change at a time, then re-run the same command.
3. Errors are information — they are not failure.
4. Look in `docs/TROUBLESHOOTING.md` first; it has a table of common problems.

**Handy commands**
```bash
docker compose ps                       # what is running (full stack)
docker compose -f docker-compose.dev.yml ps   # what is running (dev infra)
docker compose logs gateway --tail=100  # last 100 log lines of the gateway
docker compose down -v                  # stop everything and delete data (fresh start)
npm run infra:down && npm run infra:up  # restart the database/Redis
```

**When you ask for help, include** (copy-paste, don't screenshot if you can avoid it):
```
1. What I was doing (exact command): ...
2. My OS (Windows 11 / macOS / Ubuntu) and node --version: ...
3. The FIRST error message in full (not just the last line): ...
4. What I already tried: ...
```
**Never paste** your `.env` contents, API keys, or admin token.

**The nuclear options**
* Weird dependency problems: delete the `node_modules` folder and `package-lock.json`, run `npm install` again.
* Weird Docker problems: `docker compose down -v` then `docker compose up --build`.
* Weird database state in dev: `npm run infra:down`, then in Docker Desktop delete the `llm-gateway-dev_pgdata_dev` volume, then `npm run infra:up` and `npm run migrate`.

---

## Part 18 — Use it from your other projects

Your other apps (FinRAG, FinAgent, FinTune…) can call the gateway instead of the AI company directly. Step by step:
1. Create a tenant for each app (`npm run create-tenant -- finrag 5000000`) → copy its key.
2. In the other app, set the base URL to `http://localhost:8080/v1` and the API key to the `lgw_…` key. Example (Python OpenAI library):
   ```python
   from openai import OpenAI
   client = OpenAI(base_url="http://localhost:8080/v1", api_key="lgw_...")
   ```
3. Use a model name that the gateway lists at `GET /v1/models`.

**What will NOT work yet:** embeddings calls (`/v1/embeddings`), tool/function calling, JSON mode — the gateway answers `400` for the last two so you notice. A RAG app should keep its embedding calls going directly to its embedding provider. Details: `docs/DOGFOODING.md`.

---

## Part 19 — What to build next (optional improvements)

Ordered by value. Each is a good "next feature" to ask your assistant to build with you:

1. **Model aliases** — map a gateway model name (e.g. `llama-3-70b`) to each provider's real model ID so cross-vendor failover works. *(The biggest gap.)*
2. **`/v1/embeddings` endpoint** — so RAG apps can route everything through the gateway.
3. **Auth-failure throttling** and a **per-user admin login** (the admin token is a single shared secret today).
4. **Log retention** — automatically delete old `request_logs`.
5. **Run `npm audit`** and enable GitHub Dependabot to keep libraries updated.
6. **Shared circuit-breaker state** (Redis) for multi-instance deployments.
7. **Tool-calling / JSON-mode pass-through** for agent apps.

Also read `docs/SECURITY_AUDIT.md` — it lists every known weakness honestly.

---

## Part 20 — Glossary and "am I done?" checklist

| Word | Plain meaning |
|---|---|
| **API** | A way for programs to talk to each other over the network. |
| **API key** | A password-like string identifying who is calling. |
| **Tenant** | One customer/app using the gateway (with its own key, limits, budget). |
| **Token** | A piece of text (~¾ of a word) — AI companies charge per token. |
| **Rate limit** | Max calls per second allowed. |
| **Token budget** | Max tokens allowed per month. |
| **Cache** | Saved answers, so repeats are instant and free. |
| **Semantic cache** | A cache that matches *similar* questions, not only identical ones. |
| **Provider** | An AI company (Groq, Gemini, OpenRouter) or the free mock. |
| **Fallback** | Trying another provider when one fails. |
| **Circuit breaker** | Temporarily stops calling a provider that keeps failing. |
| **Streaming (SSE)** | Receiving the answer piece by piece as it's generated. |
| **Docker / container** | A packaged mini-computer for running a program the same way everywhere. |
| **Migration** | A script that creates/updates database tables. |
| **CI** | Automatic checks that run on GitHub whenever you push code. |
| **`.env`** | Your private settings file (secrets!). |

### ✅ Final checklist
- [ ] Node, Git, Docker, VS Code installed; versions verified (Part 1)
- [ ] `npm install` done; `package-lock.json` exists (Part 4)
- [ ] `npm run setup` created `.env` (Part 4)
- [ ] `npm run typecheck`, `npm run lint`, `npm test` all pass (Part 5)
- [ ] Database + Redis running; `npm run migrate` applied 3 migrations (Part 6)
- [ ] `npm run test:integration` passes (Part 7)
- [ ] Gateway answers a request; second identical request is a cache HIT (Part 8)
- [ ] Dashboard works and shows your requests (Part 9)
- [ ] Failover, circuit breaker, streaming and rate limit demonstrated (Part 10)
- [ ] `docker compose up --build` works and `npm run smoke` passes (Part 11)
- [ ] (Optional) real provider tested; `pricing.json` filled in (Part 12)
- [ ] Benchmarks run; **your own** numbers recorded (Part 14)
- [ ] Pushed to GitHub with **no `.env`** in the repo; CI is green (Part 15)
- [ ] README/résumé/portfolio updated with real results only (Part 16)

When every box is ticked, the project is genuinely **complete and verified** — and you will understand every part of it, which is what matters in an interview. `docs/INTERVIEW_GUIDE.md` is your study sheet.
