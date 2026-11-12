// eval/run.ts
//
// Eval harness for the Unified AI Router. Run it against a LIVE `wrangler dev`
// (or a deployed URL). For every labeled prompt it:
//   1. asks the router how it WOULD classify the prompt (POST /v1/route)
//   2. runs the prompt once PER TIER via the tier override (POST /v1/chat),
//      collecting the answer + real metrics (tokens, cost, latency, logId)
//   3. scores each answer 0-100 with an LLM judge (POST /v1/chat forced to the
//      frontier tier with a strict rubric), and writes the score back to that
//      call's AI Gateway log via POST /v1/feedback (-> patchLog)
//   4. computes the "eval-optimal tier" = cheapest tier whose judge score
//      clears QUALITY_BAR
// Then it prints a markdown summary to stdout and writes eval/report.md.
//
// Requires a logged-in Cloudflare account (`npx wrangler login`) because it runs
// real inference. Run with Node 24+ (native TS): `node eval/run.ts`
// (older Node: `node --experimental-strip-types eval/run.ts` or `npx tsx eval/run.ts`).
//
// Config via env vars:
//   BASE_URL            default http://localhost:8787
//   QUALITY_BAR         default 70
//   LOG_FETCH_RETRIES   default 5   (retries when fetching the real cost log)
//   LOG_FETCH_DELAY_MS  default 1200

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TIERS = ["cheap", "balanced", "frontier"] as const;
type Tier = (typeof TIERS)[number];

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8787";
const QUALITY_BAR = Number(process.env.QUALITY_BAR ?? "70");
const LOG_FETCH_RETRIES = Number(process.env.LOG_FETCH_RETRIES ?? "5");
const LOG_FETCH_DELAY_MS = Number(process.env.LOG_FETCH_DELAY_MS ?? "1200");

const HERE = dirname(fileURLToPath(import.meta.url));

interface DatasetRow {
  prompt: string;
  expectedTier: Tier;
}

interface ChatMetrics {
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  gatewayDurationMs: number | null;
  logId: string | null;
}

interface ChatResult {
  ok: boolean;
  status: number;
  text: string;
  metrics: ChatMetrics | null;
  error: string | null;
}

interface TierOutcome {
  tier: Tier;
  ok: boolean;
  answer: string;
  score: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  logId: string | null;
}

interface PromptResult {
  prompt: string;
  expectedTier: Tier;
  classifierTier: Tier | null;
  evalOptimalTier: Tier | null;
  outcomes: Record<Tier, TierOutcome>;
}

function isTier(v: unknown): v is Tier {
  return v === "cheap" || v === "balanced" || v === "frontier";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadDataset(): DatasetRow[] {
  const raw = readFileSync(join(HERE, "dataset.jsonl"), "utf8");
  const rows: DatasetRow[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const obj = JSON.parse(trimmed) as { prompt?: unknown; expectedTier?: unknown };
    if (typeof obj.prompt === "string" && isTier(obj.expectedTier)) {
      rows.push({ prompt: obj.prompt, expectedTier: obj.expectedTier });
    }
  }
  return rows;
}

/** Ask the router which tier it WOULD pick (no inference spend). */
async function classifierTierFor(prompt: string): Promise<Tier | null> {
  try {
    const res = await fetch(`${BASE_URL}/v1/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = (await res.json()) as { routing?: { tier?: unknown } };
    const tier = data.routing?.tier;
    return isTier(tier) ? tier : null;
  } catch {
    return null;
  }
}

/** Route AND run a prompt, optionally forcing a tier. */
async function postChat(prompt: string, tier?: Tier): Promise<ChatResult> {
  const body: Record<string, unknown> = { prompt };
  if (tier) body.tier = tier;
  try {
    const res = await fetch(`${BASE_URL}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const error = typeof data.message === "string" ? data.message : `HTTP ${res.status}`;
      return { ok: false, status: res.status, text: "", metrics: null, error };
    }
    return {
      ok: true,
      status: res.status,
      text: typeof data.text === "string" ? data.text : "",
      metrics: (data.metrics as ChatMetrics | undefined) ?? null,
      error: null,
    };
  } catch (err) {
    return { ok: false, status: 0, text: "", metrics: null, error: String(err) };
  }
}

/** The AI Gateway log can lag; retry GET /v1/logs/:id to get the REAL cost. */
async function fetchRealCost(logId: string | null): Promise<number | null> {
  if (!logId) return null;
  for (let attempt = 0; attempt < LOG_FETCH_RETRIES; attempt++) {
    await sleep(LOG_FETCH_DELAY_MS);
    try {
      const res = await fetch(`${BASE_URL}/v1/logs/${encodeURIComponent(logId)}`);
      if (res.ok) {
        const data = (await res.json()) as { costUsd?: unknown };
        if (typeof data.costUsd === "number") return data.costUsd;
      }
    } catch {
      // ignore and retry
    }
  }
  return null;
}

function judgePrompt(prompt: string, answer: string): string {
  return [
    "You are a strict grader scoring how well an ANSWER responds to a PROMPT.",
    "Scale 0-100: 0 = wrong or useless, 50 = partially correct, 100 = expert, fully correct and complete.",
    "Penalize factual errors, missing steps, and incomplete reasoning harshly.",
    "Respond with ONLY a single integer from 0 to 100 — no words, no punctuation, no explanation.",
    "",
    "PROMPT:",
    prompt,
    "",
    "ANSWER:",
    answer,
    "",
    "Score (0-100):",
  ].join("\n");
}

function parseScore(text: string): number | null {
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Math.round(Number(match[0]));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

/** Score an answer with the frontier model acting as judge. Returns score + judge logId. */
async function judge(prompt: string, answer: string): Promise<{ score: number | null; logId: string | null }> {
  if (!answer.trim()) return { score: 0, logId: null };
  const res = await postChat(judgePrompt(prompt, answer), "frontier");
  if (!res.ok) return { score: null, logId: null };
  return { score: parseScore(res.text), logId: res.metrics?.logId ?? null };
}

/** Write a judge score back to a call's gateway log via patchLog (best-effort). */
async function sendFeedback(
  logId: string | null,
  score: number | null,
  metadata: Record<string, string | number | boolean>,
): Promise<void> {
  if (!logId || score === null) return;
  try {
    await fetch(`${BASE_URL}/v1/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ logId, score, metadata }),
    });
  } catch {
    // best-effort: never fail the run on feedback errors
  }
}

/** Cheapest tier whose judge score clears the quality bar. */
function evalOptimalTier(outcomes: Record<Tier, TierOutcome>): Tier | null {
  for (const tier of TIERS) {
    const o = outcomes[tier];
    if (o && o.ok && o.score !== null && o.score >= QUALITY_BAR) return tier;
  }
  return null;
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + "…" : oneLine;
}
function escapePipes(s: string): string {
  return s.replace(/\|/g, "\\|");
}
function fmtScore(s: number | null): string {
  return s === null ? "n/a" : String(s);
}
function fmtCost(c: number | null): string {
  return c === null ? "n/a" : "$" + c.toFixed(6);
}

function buildReport(results: PromptResult[]): string {
  const lines: string[] = [];
  lines.push("# Eval report\n");
  lines.push(`- Base URL: \`${BASE_URL}\``);
  lines.push(`- Quality bar: **${QUALITY_BAR}** (a tier "passes" when its judge score \u2265 this)`);
  lines.push(`- Prompts: **${results.length}**`);
  lines.push("- Judge: frontier tier via `/v1/chat`; scores written back to gateway logs with `patchLog()`\n");

  lines.push("## Per-prompt results\n");
  lines.push(
    "| # | Prompt | Expected | Classifier | Eval-optimal | cheap (score / cost) | balanced (score / cost) | frontier (score / cost) |",
  );
  lines.push(
    "|---|--------|----------|------------|--------------|----------------------|-------------------------|-------------------------|",
  );
  results.forEach((r, idx) => {
    const cells = TIERS.map((t) => {
      const o = r.outcomes[t];
      return `${fmtScore(o ? o.score : null)} / ${fmtCost(o ? o.costUsd : null)}`;
    });
    const match =
      r.classifierTier !== null && r.evalOptimalTier !== null && r.classifierTier === r.evalOptimalTier
        ? "\u2713"
        : "\u2717";
    const classifierCell = r.classifierTier === null ? "n/a" : `${r.classifierTier} ${match}`;
    const optimalCell = r.evalOptimalTier === null ? "none\u2265bar" : r.evalOptimalTier;
    lines.push(
      `| ${idx + 1} | ${escapePipes(truncate(r.prompt, 50))} | ${r.expectedTier} | ${classifierCell} | ${optimalCell} | ${cells[0]} | ${cells[1]} | ${cells[2]} |`,
    );
  });

  // Aggregates.
  const comparable = results.filter((r) => r.classifierTier !== null && r.evalOptimalTier !== null);
  const classifierMatches = comparable.filter((r) => r.classifierTier === r.evalOptimalTier).length;
  const accuracy = comparable.length > 0 ? (classifierMatches / comparable.length) * 100 : 0;
  const clearedBar = results.filter((r) => r.evalOptimalTier !== null).length;

  let frontierTotal = 0;
  let optimalTotal = 0;
  let costComparable = 0;
  for (const r of results) {
    const frontierCost = r.outcomes.frontier ? r.outcomes.frontier.costUsd : null;
    const optimalTier: Tier = r.evalOptimalTier ?? "frontier";
    const optimalOutcome = r.outcomes[optimalTier];
    const optimalCost = optimalOutcome ? optimalOutcome.costUsd : null;
    if (frontierCost !== null && optimalCost !== null) {
      frontierTotal += frontierCost;
      optimalTotal += optimalCost;
      costComparable++;
    }
  }
  const saved = frontierTotal - optimalTotal;
  const savedPct = frontierTotal > 0 ? (saved / frontierTotal) * 100 : 0;

  lines.push("\n## Aggregates\n");
  lines.push(
    `- **Classifier accuracy vs eval-optimal:** ${classifierMatches}/${comparable.length} = **${accuracy.toFixed(1)}%**`,
  );
  lines.push(`- **Prompts where some tier cleared the bar:** ${clearedBar}/${results.length}`);
  if (costComparable > 0) {
    lines.push(
      `- **Always-frontier baseline cost:** ${fmtCost(frontierTotal)} (over ${costComparable} prompts with known cost)`,
    );
    lines.push(`- **Eval-optimal routing cost:** ${fmtCost(optimalTotal)}`);
    lines.push(`- **Total cost saved:** ${fmtCost(saved)} (**${savedPct.toFixed(1)}%** vs always-frontier)`);
  } else {
    lines.push(
      "- **Cost savings:** real per-call cost was not available from the gateway logs (they can lag). Increase `LOG_FETCH_RETRIES`/`LOG_FETCH_DELAY_MS` and re-run. No USD savings computed this run.",
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const rows = loadDataset();
  console.log(
    `Loaded ${rows.length} prompts | base=${BASE_URL} | qualityBar=${QUALITY_BAR}\n` +
      `Running ${rows.length} x ${TIERS.length} tiers (+ a judge call each). This spends real inference.\n`,
  );

  const results: PromptResult[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    console.log(`[${i + 1}/${rows.length}] ${truncate(row.prompt, 64)}`);

    const classifierTier = await classifierTierFor(row.prompt);

    const outcomes = {} as Record<Tier, TierOutcome>;
    for (const tier of TIERS) {
      const chat = await postChat(row.prompt, tier);

      let costUsd = chat.metrics ? chat.metrics.costUsd : null;
      const logId = chat.metrics ? chat.metrics.logId : null;
      if (chat.ok && costUsd === null) {
        costUsd = await fetchRealCost(logId);
      }

      const judged = chat.ok ? await judge(row.prompt, chat.text) : { score: 0 as number | null, logId: null };

      await sendFeedback(logId, judged.score, {
        kind: "eval-judge-score",
        tier,
        expectedTier: row.expectedTier,
        qualityBar: QUALITY_BAR,
      });

      outcomes[tier] = {
        tier,
        ok: chat.ok,
        answer: chat.text,
        score: judged.score,
        costUsd,
        latencyMs: chat.metrics ? chat.metrics.latencyMs : null,
        logId,
      };

      const status = chat.ok ? "" : ` (FAILED: ${chat.error ?? "error"})`;
      console.log(`   ${tier.padEnd(9)} score=${fmtScore(judged.score)} cost=${fmtCost(costUsd)}${status}`);
    }

    const optimal = evalOptimalTier(outcomes);
    console.log(`   -> classifier=${classifierTier ?? "n/a"} eval-optimal=${optimal ?? "none>=bar"}\n`);

    results.push({
      prompt: row.prompt,
      expectedTier: row.expectedTier,
      classifierTier,
      evalOptimalTier: optimal,
      outcomes,
    });
  }

  const report = buildReport(results);
  console.log("\n" + report);

  const outPath = join(HERE, "report.md");
  writeFileSync(outPath, report, "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error("Eval run failed:", err);
  process.exit(1);
});
