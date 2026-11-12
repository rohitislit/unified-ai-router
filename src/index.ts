// src/index.ts
//
// The HTTP surface. One Hono app exposes:
//   GET  /            -> self-contained demo UI
//   GET  /v1/models   -> the catalog
//   POST /v1/route    -> routing decision only (no inference spend)
//   POST /v1/chat     -> route AND run via the env.AI binding (-> AI Gateway)
//
// All inference flows through env.AI.run(model, { messages }, { gateway: { id }}),
// which routes BOTH native ("@cf/...") and third-party ("author/model") models
// through AI Gateway for caching, logging, and observability.

import { Hono } from "hono";
import { CATALOG, TIERS, classify, isTier, pickModel } from "./router";
import type { ModelEntry, Tier } from "./router";

/** OpenAI-style chat message. */
interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Accepted request body: either { prompt } or { messages }, plus an optional { tier } override. */
interface RouteBody {
  prompt?: string;
  messages?: ChatMessage[];
  tier?: unknown;
}

/** The routing decision returned by every /v1/* call. */
interface Routing {
  tier: Tier;
  reason: string;
  model: ModelEntry;
  allowExternal: boolean;
  gatewayId: string;
}

const app = new Hono<{ Bindings: Env }>();

/* --------------------------------- routes --------------------------------- */

app.get("/", (c) => c.html(HTML));

// Return the catalog so callers can introspect what the router can reach.
app.get("/v1/models", (c) =>
  c.json({ tiers: TIERS, count: CATALOG.length, models: CATALOG }),
);

// Routing decision ONLY. Never touches env.AI, so it costs nothing to call.
app.post("/v1/route", async (c) => {
  const body = await readBody(c.req.raw);
  if (!body) {
    return c.json({ error: "invalid_json", message: "Request body must be JSON." }, 400);
  }
  const messages = buildMessages(body);
  if (!messages) {
    return c.json(
      { error: "missing_input", message: "Provide { prompt } or a non-empty { messages } array." },
      400,
    );
  }
  const routing = resolveRouting(body, c.env, messages);
  return c.json({ routing, note: "Routing decision only — no inference was run." });
});

// Route AND run. Measures latency, normalizes the provider response, and
// returns a 502 (with the routing info) if inference fails.
app.post("/v1/chat", async (c) => {
  const body = await readBody(c.req.raw);
  if (!body) {
    return c.json({ error: "invalid_json", message: "Request body must be JSON." }, 400);
  }
  const messages = buildMessages(body);
  if (!messages) {
    return c.json(
      { error: "missing_input", message: "Provide { prompt } or a non-empty { messages } array." },
      400,
    );
  }
  const routing = resolveRouting(body, c.env, messages);

  const started = Date.now();

  // Prefer routing through AI Gateway (caching/logging/observability + real cost).
  // If the gateway path itself errors, fall back to a direct Workers AI call so
  // the request still succeeds, and surface which path ran. Only if BOTH fail do
  // we return a 502. (model.id is typed `string`, so this hits the dynamic-model
  // overload and works for native and external models alike.)
  let raw: Record<string, unknown>;
  let gatewayUsed = true;
  let gatewayError: string | null = null;
  try {
    raw = await c.env.AI.run(routing.model.id, { messages }, { gateway: { id: routing.gatewayId } });
  } catch (err) {
    gatewayError = err instanceof Error ? err.message : String(err);
    try {
      raw = await c.env.AI.run(routing.model.id, { messages });
      gatewayUsed = false;
    } catch (err2) {
      const latencyMs = Date.now() - started;
      const message = err2 instanceof Error ? err2.message : String(err2);
      return c.json({ error: "inference_failed", message, gatewayError, routing, latencyMs }, 502);
    }
  }

  const latencyMs = Date.now() - started;
  const metrics = await collectMetrics(c.env, routing.gatewayId, raw, latencyMs);
  return c.json({
    routing,
    text: extractText(raw),
    metrics: { ...metrics, gatewayUsed, gatewayError },
    raw,
  });
});

// Attach a quality score (0-100) + metadata to a prior call's AI Gateway log.
// The eval harness uses this to write LLM-judge scores back via patchLog().
app.post("/v1/feedback", async (c) => {
  const body = await readJsonObject(c.req.raw);
  if (!body) {
    return c.json({ error: "invalid_json", message: "Request body must be JSON." }, 400);
  }
  const logId = typeof body["logId"] === "string" ? body["logId"] : "";
  if (!logId) {
    return c.json(
      { error: "missing_logId", message: "Provide a string logId from a prior /v1/chat call." },
      400,
    );
  }
  const rawScore = body["score"];
  const score =
    typeof rawScore === "number" && Number.isFinite(rawScore)
      ? Math.max(0, Math.min(100, Math.round(rawScore)))
      : null;
  const metadata = sanitizeMetadata(body["metadata"]);

  try {
    await c.env.AI.gateway(String(c.env.GATEWAY_ID)).patchLog(logId, { score, metadata });
    return c.json({ ok: true, logId, score });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: "patch_failed", message, logId }, 502);
  }
});

// Fetch the REAL cost/duration/token counts for a prior call from its AI Gateway
// log. Logs can lag a moment, so this 404s until the entry is ready — callers
// (like the eval harness) should retry.
app.get("/v1/logs/:id", async (c) => {
  const logId = c.req.param("id");
  const log = await safeGetLog(c.env, String(c.env.GATEWAY_ID), logId);
  if (!log) {
    return c.json(
      { error: "log_unavailable", message: "Log not ready yet or gateway error; retry shortly.", logId },
      404,
    );
  }
  return c.json({
    logId,
    model: log.model,
    provider: log.provider,
    costUsd: typeof log.cost === "number" ? log.cost : null,
    gatewayDurationMs: typeof log.duration === "number" ? log.duration : null,
    promptTokens: typeof log.tokens_in === "number" ? log.tokens_in : null,
    completionTokens: typeof log.tokens_out === "number" ? log.tokens_out : null,
    success: log.success,
    cached: log.cached,
    statusCode: log.status_code,
  });
});

export default app;

/* -------------------------------- helpers --------------------------------- */

/** Parse a JSON object body, tolerating malformed/non-object payloads. */
async function readBody(req: Request): Promise<RouteBody | null> {
  try {
    const data: unknown = await req.json();
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as RouteBody;
    }
    return null;
  } catch {
    return null;
  }
}

/** Build a clean messages[] from either { messages } or { prompt }. Returns null if neither is usable. */
function buildMessages(body: RouteBody): ChatMessage[] | null {
  if (Array.isArray(body.messages)) {
    const clean = body.messages.filter(
      (m): m is ChatMessage =>
        !!m &&
        typeof m === "object" &&
        (m.role === "system" || m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string",
    );
    if (clean.length > 0) return clean;
  }
  if (typeof body.prompt === "string" && body.prompt.trim().length > 0) {
    return [{ role: "user", content: body.prompt }];
  }
  return null;
}

/** The text the classifier should look at: the explicit prompt, else the user turns. */
function classifyText(body: RouteBody, messages: ChatMessage[]): string {
  if (typeof body.prompt === "string" && body.prompt.trim().length > 0) {
    return body.prompt;
  }
  const userText = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
  return userText.length > 0 ? userText : messages.map((m) => m.content).join("\n");
}

/** Combine an optional tier override + classification into a final routing decision. */
function resolveRouting(body: RouteBody, env: Env, messages: ChatMessage[]): Routing {
  // Coerce the var to a plain string first: `wrangler types` infers it as the
  // literal "false", and comparing a literal to "true" would be a type error.
  const allowExternal = String(env.ALLOW_EXTERNAL).toLowerCase() === "true";

  let tier: Tier;
  let reason: string;
  if (isTier(body.tier)) {
    tier = body.tier;
    reason = `Explicit tier override: "${tier}".`;
  } else {
    const decision = classify(classifyText(body, messages));
    tier = decision.tier;
    reason = decision.reason;
  }

  const model = pickModel(tier, { allowExternal });
  if (model.tier !== tier) {
    reason += ` Tier "${tier}" had no eligible model; fell back to Workers AI "${model.id}".`;
  }

  return { tier, reason, model, allowExternal, gatewayId: String(env.GATEWAY_ID) };
}

/** Normalize Workers AI ({ response }) and OpenAI ({ choices }) response shapes to plain text. */
function extractText(raw: Record<string, unknown>): string {
  // Workers AI native shape.
  if (typeof raw["response"] === "string") {
    return raw["response"];
  }
  // OpenAI-compatible shape.
  const choices = raw["choices"];
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const message = first["message"];
    if (message && typeof message === "object") {
      const content = (message as Record<string, unknown>)["content"];
      if (typeof content === "string") return content;
    }
    if (typeof first["text"] === "string") {
      return first["text"] as string;
    }
  }
  // Unknown shape: hand back the raw JSON so nothing is silently dropped.
  return JSON.stringify(raw);
}

/** Real, measured metrics for a single /v1/chat call. Token/cost fields are null when unavailable. */
interface ChatMetrics {
  latencyMs: number; // measured locally around env.AI.run()
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null; // REAL cost from the AI Gateway log (best-effort)
  gatewayDurationMs: number | null; // gateway-measured duration from the log
  logId: string | null; // AI Gateway log id for this call (use with /v1/feedback)
}

/**
 * Assemble real metrics for the call we just ran:
 *  - inline `usage` tokens from the model response (degrade gracefully if absent)
 *  - the AI Gateway log id (env.AI.aiGatewayLogId)
 *  - best-effort getLog() for the REAL cost + duration (the log can lag, so this
 *    is non-blocking-correctness: a missing/slow log never breaks the response)
 */
async function collectMetrics(
  env: Env,
  gatewayId: string,
  raw: Record<string, unknown>,
  latencyMs: number,
): Promise<ChatMetrics> {
  const logId = env.AI.aiGatewayLogId;

  const usage = readUsage(raw);
  let promptTokens = usage.promptTokens;
  let completionTokens = usage.completionTokens;
  let totalTokens = usage.totalTokens;

  let costUsd: number | null = null;
  let gatewayDurationMs: number | null = null;

  if (logId) {
    const log = await safeGetLog(env, gatewayId, logId);
    if (log) {
      if (typeof log.cost === "number") costUsd = log.cost;
      if (typeof log.duration === "number") gatewayDurationMs = log.duration;
      if (promptTokens === null && typeof log.tokens_in === "number") promptTokens = log.tokens_in;
      if (completionTokens === null && typeof log.tokens_out === "number") completionTokens = log.tokens_out;
    }
  }
  if (totalTokens === null && promptTokens !== null && completionTokens !== null) {
    totalTokens = promptTokens + completionTokens;
  }

  return { latencyMs, promptTokens, completionTokens, totalTokens, costUsd, gatewayDurationMs, logId };
}

/** Read the OpenAI/Workers-AI `usage` object if the model returned one. */
function readUsage(raw: Record<string, unknown>): {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
} {
  const out = { promptTokens: null as number | null, completionTokens: null as number | null, totalTokens: null as number | null };
  const usage = raw["usage"];
  if (usage && typeof usage === "object") {
    const u = usage as Record<string, unknown>;
    if (typeof u["prompt_tokens"] === "number") out.promptTokens = u["prompt_tokens"];
    if (typeof u["completion_tokens"] === "number") out.completionTokens = u["completion_tokens"];
    if (typeof u["total_tokens"] === "number") out.totalTokens = u["total_tokens"];
  }
  return out;
}

/** getLog() that never throws: returns the log or null if it isn't ready / errored. */
async function safeGetLog(env: Env, gatewayId: string, logId: string): Promise<AiGatewayLog | null> {
  try {
    return await env.AI.gateway(gatewayId).getLog(logId);
  } catch {
    return null;
  }
}

/** Parse a JSON object body, tolerating malformed/non-object payloads. */
async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const data: unknown = await req.json();
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Keep only primitive metadata values that patchLog accepts. */
function sanitizeMetadata(
  value: unknown,
): Record<string, string | number | boolean | null> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    }
  }
  return out;
}

/* ----------------------------- demo UI (HTML) ----------------------------- */

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Unified AI Router</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    margin: 0; padding: 2rem 1rem; background: #0b0d12; color: #e7e9ee;
    display: flex; justify-content: center;
  }
  main { width: 100%; max-width: 760px; }
  h1 { margin: 0 0 .25rem; font-size: 1.6rem; }
  p.sub { margin: 0 0 1.5rem; color: #9aa3b2; }
  label { display: block; font-weight: 600; margin: 1rem 0 .35rem; }
  textarea, select {
    width: 100%; padding: .7rem .8rem; border-radius: 10px; border: 1px solid #2a2f3a;
    background: #12151c; color: inherit; font: inherit;
  }
  textarea { min-height: 120px; resize: vertical; }
  .row { display: flex; gap: .75rem; align-items: end; flex-wrap: wrap; }
  .row > div { flex: 1 1 180px; }
  .btns { display: flex; gap: .6rem; margin-top: 1.1rem; }
  button {
    cursor: pointer; border: 0; border-radius: 10px; padding: .7rem 1.1rem;
    font: inherit; font-weight: 600;
  }
  #preview { background: #232936; color: #e7e9ee; }
  #send { background: #f6821f; color: #1a1205; }
  button:active { transform: translateY(1px); }
  #status { margin: 1.1rem 0 .4rem; min-height: 1.3em; color: #9aa3b2; font-size: .9rem; }
  pre {
    background: #12151c; border: 1px solid #2a2f3a; border-radius: 10px;
    padding: 1rem; overflow: auto; white-space: pre-wrap; word-break: break-word;
    margin: 0; max-height: 60vh;
  }
  a { color: #f6821f; }
  code { background: #12151c; padding: .1rem .35rem; border-radius: 6px; }
</style>
</head>
<body>
<main>
  <h1>Unified AI Router</h1>
  <p class="sub">
    Send a prompt, not a model name. The router classifies it into a tier and
    picks the cheapest model that clears the bar, then runs it through the
    Workers AI binding so all traffic flows through AI Gateway.
  </p>

  <label for="prompt">Prompt</label>
  <textarea id="prompt" placeholder="e.g. Explain why quicksort is O(n log n) on average...">Write a haiku about Cloudflare Workers.</textarea>

  <div class="row">
    <div>
      <label for="tier">Tier</label>
      <select id="tier">
        <option value="auto">auto (classify)</option>
        <option value="cheap">cheap</option>
        <option value="balanced">balanced</option>
        <option value="frontier">frontier</option>
      </select>
    </div>
  </div>

  <div class="btns">
    <button id="preview" type="button">Preview route</button>
    <button id="send" type="button">Send</button>
  </div>

  <div id="status"></div>
  <pre id="out">Routing and responses show up here. Try "Preview route" first — it costs nothing.

GET <a href="/v1/models">/v1/models</a> lists the catalog.</pre>
</main>

<script>
  function $(sel) { return document.querySelector(sel); }
  var promptEl = $("#prompt");
  var tierEl = $("#tier");
  var out = $("#out");
  var statusEl = $("#status");

  function buildBody() {
    var b = { prompt: promptEl.value };
    if (tierEl.value !== "auto") { b.tier = tierEl.value; }
    return b;
  }

  function call(path) {
    statusEl.textContent = "Calling " + path + " ...";
    out.textContent = "";
    var t0 = performance.now();
    fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildBody())
    })
    .then(function (res) {
      return res.json().then(function (data) {
        var dt = Math.round(performance.now() - t0);
        statusEl.textContent = path + " -> HTTP " + res.status + " (" + dt + " ms round trip)";
        out.textContent = JSON.stringify(data, null, 2);
      });
    })
    .catch(function (err) {
      statusEl.textContent = "Request failed";
      out.textContent = String(err);
    });
  }

  $("#preview").addEventListener("click", function () { call("/v1/route"); });
  $("#send").addEventListener("click", function () { call("/v1/chat"); });
</script>
</body>
</html>`;
