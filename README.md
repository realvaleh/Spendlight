# Spendlight

Drop-in **OpenAI-compatible** local reverse proxy. Clients only swap the base URL. Spendlight logs every completion to SQLite, enforces soft/hard budgets (with a kill-switch), and serves a small local dashboard plus shareable Markdown/SVG receipts.

> v1 is cost, budgets, and receipts only.

![Spendlight dashboard](docs/dashboard.png)

Sample receipt: [docs/receipt-sample.svg](docs/receipt-sample.svg) · local badge: `http://127.0.0.1:8787/badge.svg`

```md
![spend](http://127.0.0.1:8787/badge.svg)
```

## What it is

A single Node process that:

1. Speaks the OpenAI Chat Completions API at `/v1/chat/completions` (other `/v1/*` paths pass through).
2. Forwards to any OpenAI-compatible upstream (`OPENAI_BASE_URL` + `OPENAI_API_KEY`).
3. Writes a spend ledger (model, tokens, estimated USD, project/tag, timestamp, request id).
4. Rejects further completions with a clear error when a **hard** budget is hit.
5. Renders a one-page dashboard, Markdown + SVG receipts, and a README badge.

## Architecture

```
  OpenAI SDK / curl / app
           |
           |  baseURL = http://127.0.0.1:8787/v1
           v
  ┌──────────────────────────────────────────┐
  │              Spendlight                  │
  │  /                 local dashboard       │
  │  /receipt.md .svg  shareable receipts    │
  │  /badge.svg        README badge          │
  │  /v1/*             reverse proxy         │
  │        │                                 │
  │        ├─ budget check (SQLite sums)     │
  │        │    soft → warning header        │
  │        │    hard → 402 kill-switch       │
  │        ├─ upstream fetch                 │
  │        └─ ledger insert (tokens × price) │
  └──────────────────────────────────────────┘
           |                      |
           v                      v
   OpenAI-compatible API     SQLite (WAL)
   OPENAI_BASE_URL           SPENDLIGHT_DB
```

Pricing is a local table (sane OpenAI defaults, overridable in `spendlight.config.json`). Costs are **estimates**.

Tag traffic with `x-spendlight-project` (or `x-spendlight-tag`, `?project=`, or `spendlight_project` in the JSON body). That is the budget bucket.

## Quickstart

Needs **Node 22.13+** (uses the built-in `node:sqlite` module).

```bash
git clone https://github.com/realvaleh/Spendlight.git
cd Spendlight
cp .env.example .env          # set OPENAI_API_KEY
cp spendlight.config.example.json spendlight.config.json
npm install
npm start                     # http://127.0.0.1:8787
```

Point a client at the proxy:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
# keep OPENAI_API_KEY as-is, or let Spendlight inject it

curl http://127.0.0.1:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -H "x-spendlight-project: demo" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787) for the dashboard.

### Docker one-liner

```bash
docker compose up --build
# or
docker build -t spendlight . && docker run --rm -p 8787:8787 \
  -e OPENAI_API_KEY \
  -e SPENDLIGHT_HARD_BUDGET_USD=25 \
  -v spendlight-data:/data spendlight
```

### npx

```bash
npx github:realvaleh/Spendlight
```

## Env vars

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Upstream key if the client does not send `Authorization` |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Upstream OpenAI-compatible base |
| `SPENDLIGHT_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` in Docker) |
| `SPENDLIGHT_PORT` | `8787` | Listen port |
| `SPENDLIGHT_DB` | `./data/spendlight.db` | SQLite path (`/data/spendlight.db` in Docker) |
| `SPENDLIGHT_CONFIG` | `./spendlight.config.json` | Optional JSON config |
| `SPENDLIGHT_SOFT_BUDGET_USD` | — | Global soft budget (warn) |
| `SPENDLIGHT_HARD_BUDGET_USD` | — | Global hard budget (kill-switch) |

CLI: `spendlight --config ./spendlight.config.json --port 8787`

Per-project budgets live in the config file (`budgets.projects.<name>`). Env vars override the **global** budget.

Hard-limit responses look like OpenAI errors:

```json
{
  "error": {
    "message": "Spendlight hard budget exceeded (global 'global'): $0.045 / $0.040. Kill-switch is on; further completions are rejected.",
    "type": "spendlight_budget_exceeded",
    "code": "budget_hard_limit"
  }
}
```

HTTP status is **402**. The request is not forwarded upstream.

## Receipts

| URL | What |
| --- | --- |
| `/` | Dashboard (spend, budgets, recent requests) |
| `/receipt.md` | Markdown receipt |
| `/receipt.svg` | Paper-style SVG receipt |
| `/badge.svg` | Shields-style badge for a local README |
| `/api/summary` | JSON for the same numbers |
| `/health` | Liveness |

Streaming chat completions: Spendlight sets `stream_options.include_usage` so the final SSE chunk can be logged.

## Smoke test

Proves logging + kill-switch against a **mock** upstream (no paid call):

```bash
npm test
```

## Non-goals (v1)

- Tracing, evals, or observability suites
- Multi-provider routing, load balancing, or failover zoos
- Auth on the dashboard (bind to localhost; this is a local tool)
- Perfect billing-grade invoices (estimates from the price table only)

## Stack

TypeScript + Node 22 (`node:http`, `fetch`, `node:sqlite`). Zero runtime npm dependencies.

MIT licensed. See [LICENSE](LICENSE).
