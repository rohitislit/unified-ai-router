# Unified AI Router

One HTTP endpoint for AI inference. The caller sends a **prompt, not a model
name**. The router classifies the prompt into a quality/price **tier**, picks the
**cheapest model that clears the bar**, and runs it through the **Workers AI
binding** so every request flows through **AI Gateway** for caching, logging, and
observability.

```
POST /v1/chat   { "prompt": "Explain why quicksort is O(n log n)" }
        |
        v
  classify() ── reasoning keywords ─► frontier
             ── long prompt ─────────► balanced
             ── otherwise ───────────► cheap
        |
        v
  pickModel(tier) ─► cheapest model in tier (native unless ALLOW_EXTERNAL)
        |
        v
  env.AI.run(model, { messages }, { gateway: { id }})  ─►  AI Gateway  ─►  model
```

## Product thesis

Cloudflare is converging on a **single, unified inference API**: AI Gateway and
Workers AI now meet at one call — `env.AI.run(model, input, { gateway: { id }})` —
which routes **both** native Workers AI models (`@cf/...`) **and** third-party
models (`author/model`) through the gateway. The platform gives you the pipe,
the cache, and the logs.

What it does *not* give you is **policy**: _which_ model should answer _this_
prompt, and why. That is the open layer this project fills. The Unified AI Router
is a thin, transparent **routing-policy layer** on top of the unified API —
prompt in, decision + answer out — with the classification logic kept as plain,
swappable functions instead of a black box.

> Pricing note: Workers AI bills in **neurons**, not dollars. The `relativeCost`
> weights in the catalog are **illustrative ranking hints only** — they exist to
> sort candidates within a tier, not to estimate spend. See "Where to take it
> next" for real neuron-based accounting.

## Architecture

```
                         ┌─────────────────────────────────────────┐
                         │            Worker (Hono app)             │
   client ──HTTP──►      │                                          │
                         │   src/index.ts        src/router.ts      │
                         │   ┌────────────┐      ┌───────────────┐  │
   GET  /            ────┼─► │ demo UI    │      │ CATALOG       │  │
   GET  /v1/models   ────┼─► │ endpoints  │ ───► │ classify()    │  │
   POST /v1/route    ────┼─► │            │      │ pickModel()   │  │
   POST /v1/chat     ────┼─► │            │      └───────────────┘  │
                         │   └─────┬──────┘                         │
                         └─────────┼────────────────────────────────┘
                                   │ env.AI.run(model, { messages },
                                   │            { gateway: { id }})
                                   ▼
                         ┌──────────────────────┐
                         │      AI Gateway       │  caching · logging · metrics
                         └──────────┬────────────┘
                                    │
                  ┌─────────────────┴───────────────────┐
                  ▼                                      ▼
        Workers AI native models            External providers (opt-in)
        "@cf/meta/llama-3.2-3b-instruct"     "openai/gpt-4o"
        "@cf/meta/llama-3.1-8b-instruct-fp8"  (needs ALLOW_EXTERNAL=true +
        "@cf/meta/llama-3.3-70b-...-fast"      a provider key in the dashboard)
```

- **`src/router.ts`** — pure, network-free policy: the typed `CATALOG`,
  `classify(prompt)`, and `pickModel(tier, { allowExternal })`.
- **`src/index.ts`** — the Hono app: HTTP surface, request parsing, response
  normalization, and the single `env.AI.run(...)` call.
- **AI Gateway** — every inference call passes through it via the
  `{ gateway: { id } }` option, so caching/logging/observability are automatic.

### Routing rules (`classify`)

| Signal in the prompt                         | Tier       | Default model                              |
| -------------------------------------------- | ---------- | ------------------------------------------ |
| Reasoning keywords (`why`, `prove`, `debug`, `analyze`, `algorithm`, …) | `frontier` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| Long prompt (≥ 400 chars)                    | `balanced` | `@cf/meta/llama-3.1-8b-instruct-fp8`       |
| Everything else                              | `cheap`    | `@cf/meta/llama-3.2-3b-instruct`           |

`pickModel` returns the **cheapest** entry in the chosen tier, **filters out
external models** unless `ALLOW_EXTERNAL=true`, and falls back to the cheapest
Workers AI native model if a tier has no eligible entry. A request may also send
`{ "tier": "frontier" }` to **override** the classifier.

## Endpoints

| Method & path        | Body                                               | Does it spend? | Returns                                                              |
| -------------------- | -------------------------------------------------- | -------------- | ------------------------------------------------------------------- |
| `GET  /`             | —                                                  | No             | Self-contained HTML demo UI                                         |
| `GET  /v1/models`    | —                                                  | No             | `{ tiers, count, models }` — the full catalog                       |
| `POST /v1/route`     | `{ prompt }` or `{ messages }` (+ optional `tier`) | **No**         | `{ routing, note }` — the routing decision only                     |
| `POST /v1/chat`      | `{ prompt }` or `{ messages }` (+ optional `tier`) | **Yes**        | `{ routing, text, metrics, raw }` (or `502 { error, routing }`)     |
| `POST /v1/feedback`  | `{ logId, score, metadata? }`                      | No             | `{ ok, logId, score }` — writes a 0-100 score to the log (`patchLog`) |
| `GET  /v1/logs/:id`  | —                                                  | No             | Real `{ costUsd, gatewayDurationMs, tokens, ... }` from the log (`getLog`) |

The router accepts either a plain `{ prompt }` or an OpenAI-style `{ messages }`
array, plus an optional `{ tier }` override. `/v1/chat` normalizes both the
Workers AI (`{ response }`) and OpenAI (`{ choices: [...] }`) response shapes into
a single `text` field.

### Real metrics on `/v1/chat`

Every `/v1/chat` response carries a `metrics` object built from **measured** data,
not estimates:

```jsonc
"metrics": {
  "latencyMs": 412,          // measured locally around env.AI.run()
  "promptTokens": 18,        // from the model's `usage` object (when present)
  "completionTokens": 64,
  "totalTokens": 82,
  "costUsd": 0.000031,       // REAL cost from the AI Gateway log (best-effort)
  "gatewayDurationMs": 389,  // gateway-measured duration from the log
  "logId": "01H....",        // AI Gateway log id — use with /v1/feedback
  "gatewayUsed": true,       // false if the gateway errored and we fell back to a direct call
  "gatewayError": null       // the gateway error message when gatewayUsed is false
}
```

After inference the Worker captures `env.AI.aiGatewayLogId`, reads the inline
`usage` tokens, and **best-effort** calls `env.AI.gateway(id).getLog(logId)` for
the real cost/duration. Gateway logs can lag a moment, so a missing log never
breaks the response — `costUsd`/`gatewayDurationMs` simply come back `null` and
you can re-fetch them later via `GET /v1/logs/:id`. The `relativeCost` weights in
the catalog are now clearly labeled as a **fallback ranking hint** used only
*before* real cost is known.

**Gateway-first with a safety net.** `/v1/chat` always *prefers* the gateway
(`env.AI.run(model, { messages }, { gateway: { id }})`). If that specific call
errors, it falls back to a direct `env.AI.run(model, { messages })` so the
caller still gets an answer, and the response records `gatewayUsed: false` plus
the `gatewayError`. Only if **both** paths fail does it return a `502`. When the
gateway is bypassed there's no gateway log, so `costUsd` is `null` for that call.

### Examples

```bash
# Preview the decision — no inference, no spend:
curl -s localhost:8787/v1/route \
  -H 'content-type: application/json' \
  -d '{"prompt":"Explain why quicksort is O(n log n) on average."}'
# -> { "routing": { "tier": "frontier", "model": { "id": "@cf/meta/llama-3.3-70b-instruct-fp8-fast", ... }, ... }, "note": "..." }

# Route AND run:
curl -s localhost:8787/v1/chat \
  -H 'content-type: application/json' \
  -d '{"prompt":"Write a haiku about Cloudflare Workers."}'
# -> { "routing": {...}, "text": "...", "metrics": { "latencyMs": 412, "costUsd": 0.00003, ... }, "raw": {...} }

# Override the tier and use OpenAI-style messages:
curl -s localhost:8787/v1/chat \
  -H 'content-type: application/json' \
  -d '{"tier":"cheap","messages":[{"role":"user","content":"hi"}]}'

# Inspect the catalog:
curl -s localhost:8787/v1/models
```

## Run it

### Prerequisites

- Node.js 22 or newer (Node.js 24+ is recommended for the eval harness)
- npm
- A Cloudflare account with Workers AI access for live inference

```bash
npm ci
npm run dev        # wrangler dev — open http://localhost:8787
```

Live inference requires a Cloudflare account:

```bash
npx wrangler login
```

By default the router uses **Workers AI native models only**, so it works with
just a Cloudflare account — no third-party keys needed.

## Deploy it

```bash
npm run deploy     # wrangler deploy
```

Configuration lives in `wrangler.jsonc`:

| Var             | Default     | Meaning                                                        |
| --------------- | ----------- | -------------------------------------------------------------- |
| `GATEWAY_ID`    | `"default"` | AI Gateway id used for caching/logging/observability           |
| `ALLOW_EXTERNAL`| `"false"`   | Opt-in switch for external (non-Workers-AI) providers          |

The `AI` binding (`"ai": { "binding": "AI" }`) and `observability` are enabled in
the config.

### Enabling external providers (opt-in)

External models like `openai/gpt-4o` are off by default. To enable:

1. In the **AI Gateway dashboard**, store the provider's API key (BYOK) — keys
   live in the gateway, **never** in this Worker.
2. Set `ALLOW_EXTERNAL` to `"true"` in `wrangler.jsonc` (or as a deployment var).
3. Re-deploy. The `frontier` tier can now select `openai/gpt-4o`.

> The AI Gateway **Universal Endpoint is deprecated** — this router does not use
> it. For external providers, the preferred paths are the OpenAI-compatible
> endpoint and **Dynamic Routing** for fallbacks; the default path here is the
> `env.AI` binding.

## Verify

```bash
npm test
npm run typecheck               # generate Worker types, then type-check
npx wrangler deploy --dry-run   # bundle without deploying
```

All three should pass with no account required.

## Evaluating the router

The keyword classifier and the `relativeCost` weights are guesses until you
measure them. The eval harness in `eval/` replaces both with **real data**: it
runs every prompt at every tier, has an LLM judge score the answers, and reports
which tier each prompt *actually* needed and how much routing to it would save.

**What it does**, for each labeled prompt in `eval/dataset.jsonl`:

1. Asks the router how it would classify the prompt (`POST /v1/route`).
2. Runs the prompt **once per tier** via the `tier` override (`POST /v1/chat`),
   collecting the answer + real `metrics` (tokens, cost, latency, `logId`).
3. Scores each answer **0-100** with an LLM judge — a `POST /v1/chat` call forced
   to the `frontier` tier with a strict grading rubric — and writes the score
   back to that call's gateway log via `POST /v1/feedback` (→ `patchLog`).
4. Computes the **eval-optimal tier**: the *cheapest* tier whose judge score
   clears `QUALITY_BAR` (default 70).

**Run it** (needs a logged-in account — it runs real inference):

```bash
npx wrangler login      # if not already logged in
npm run dev             # terminal 1: start the Worker

# terminal 2:
npm run eval            # runs eval/run.ts against http://localhost:8787
# tune it:
QUALITY_BAR=80 BASE_URL=http://localhost:8787 npm run eval
```

`eval/run.ts` runs on Node 24+ (native TypeScript). On older Node, use
`node --experimental-strip-types eval/run.ts` or `npx tsx eval/run.ts`.

**Read the report.** The harness prints a markdown summary to stdout and writes
`eval/report.md`, containing:

- **Per prompt:** expected tier, the classifier's tier, the eval-optimal tier,
  and the judge score + real cost for each of the three tiers.
- **Aggregates:** classifier **accuracy vs the eval-optimal tier**, how many
  prompts any tier could satisfy, and **total cost saved** by routing to the
  eval-optimal tier instead of an always-frontier baseline.

If the classifier's tier ≠ the eval-optimal tier for many prompts, that's your
signal to adjust the heuristics in `src/router.ts` (keywords, length threshold,
tier ordering) — now backed by measured quality and cost instead of guesswork.

## Where to take it next

- **Real neuron-based cost accounting.** `costUsd` now comes straight from the AI
  Gateway log; extend it into per-model **neuron** accounting and pick on real
  cost rather than the `relativeCost` fallback ranking hint.
- **Eval-driven routing.** `eval/report.md` already tells you the eval-optimal
  tier per prompt. Tune the `classify()` heuristics against that data — or train
  an embeddings/classifier-based router on the labeled scores — so the "quality
  bar" per tier is measured, not guessed.
- **Dynamic Routing fallbacks.** For external providers, wire up AI Gateway
  **Dynamic Routing** so a frontier request can fail over across providers
  (e.g. OpenAI → Anthropic → a native Workers AI model) without app changes.
- **Feedback via `patchLog`.** `POST /v1/feedback` already writes scores to the
  gateway log via `patchLog(logId, { score, metadata })` (the log id is returned
  in `metrics.logId`). Extend it to capture end-user thumbs-up/down and feed that
  signal back into routing decisions.
- **More:** streaming (`stream: true`), per-tenant tiers/budgets, response
  caching hints via `cacheTtl`/`cacheKey`, and request `tags` for dashboard
  grouping.
