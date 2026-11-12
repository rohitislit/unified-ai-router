// src/router.ts
//
// The routing-policy layer. This file owns two pure functions — classify() and
// pickModel() — plus the model CATALOG they operate on. Nothing here talks to
// the network, so it is trivially unit-testable and cheap to reason about.

/** Quality/price tiers, ordered cheapest -> strongest. */
export type Tier = "cheap" | "balanced" | "frontier";

/** Tiers in ascending capability order. Handy for UIs and validation. */
export const TIERS: readonly Tier[] = ["cheap", "balanced", "frontier"] as const;

/** Which upstream a model runs on. Native = Workers AI, anything else is third-party via AI Gateway. */
export type Provider = "workers-ai" | "openai";

export interface ModelEntry {
  /** The exact id passed to env.AI.run(). Native models use the "@cf/..." prefix; external ones use "author/model". */
  id: string;
  tier: Tier;
  provider: Provider;
  /** true => routed to a third-party provider through AI Gateway (not Workers AI native). */
  external: boolean;
  /** true => needs a provider API key stored in the AI Gateway dashboard (never in this Worker). */
  requiresKey: boolean;
  /**
   * FALLBACK RANKING HINT ONLY — used to order candidates within a tier *before*
   * any real cost is known. This is NOT pricing: Workers AI bills in "neurons",
   * not in these numbers. Once a call runs, /v1/chat returns the REAL cost from
   * the AI Gateway log (metrics.costUsd) and the eval harness compares tiers on
   * measured cost — see eval/report.md. Lower wins when ranking is all we have.
   */
  relativeCost: number;
  /** Human-readable note shown in /v1/models and the demo UI. */
  description: string;
}

/**
 * The catalog. Defaults to Workers AI native models only (one per tier) so the
 * router runs with nothing but a Cloudflare account. The single external entry
 * (openai/gpt-4o) is opt-in: it is filtered out unless ALLOW_EXTERNAL is on AND
 * a provider key is configured in the AI Gateway dashboard.
 */
export const CATALOG: ModelEntry[] = [
  {
    id: "@cf/meta/llama-3.2-3b-instruct",
    tier: "cheap",
    provider: "workers-ai",
    external: false,
    requiresKey: false,
    relativeCost: 1, // illustrative only
    description: "Small, fast Workers AI model. Great for short prompts, classification, and boilerplate.",
  },
  {
    id: "@cf/meta/llama-3.1-8b-instruct-fp8",
    tier: "balanced",
    provider: "workers-ai",
    external: false,
    requiresKey: false,
    relativeCost: 3, // illustrative only
    description: "Mid-size Workers AI model. Solid general-purpose default for longer, everyday prompts.",
  },
  {
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    tier: "frontier",
    provider: "workers-ai",
    external: false,
    requiresKey: false,
    relativeCost: 8, // illustrative only
    description: "Large Workers AI model for hard reasoning — still runs natively on Cloudflare, no external key.",
  },
  {
    id: "openai/gpt-4o",
    tier: "frontier",
    provider: "openai",
    external: true,
    requiresKey: true,
    relativeCost: 20, // illustrative only
    description: "External OpenAI model via AI Gateway. Opt-in: needs ALLOW_EXTERNAL=true + a provider key in the AI Gateway dashboard.",
  },
];

export interface Classification {
  tier: Tier;
  reason: string;
}

/**
 * Keyword heuristics that imply the prompt wants real reasoning. Deliberately
 * simple and transparent — swap this for an embeddings/eval-driven classifier
 * later without changing the routing contract.
 */
const REASONING_HINTS: readonly string[] = [
  "why",
  "prove",
  "proof",
  "explain",
  "reason",
  "reasoning",
  "analyze",
  "analyse",
  "derive",
  "step by step",
  "step-by-step",
  "debug",
  "root cause",
  "algorithm",
  "optimize",
  "optimise",
  "trade-off",
  "tradeoff",
  "architecture",
  "theorem",
  "calculate",
  "evaluate",
  "compare",
  "refactor",
  "edge case",
];

/** Prompts at/above this many characters are treated as "long" -> balanced tier. */
const LONG_PROMPT_CHARS = 400;

/**
 * Classify a prompt into a tier using cheap, explainable heuristics:
 *   reasoning keyword  -> frontier
 *   long prompt        -> balanced
 *   otherwise          -> cheap
 * Always returns a human-readable `reason` so routing stays observable.
 */
export function classify(prompt: string): Classification {
  const text = (prompt ?? "").trim();
  const lower = text.toLowerCase();

  const hit = REASONING_HINTS.find((kw) => lower.includes(kw));
  if (hit) {
    return {
      tier: "frontier",
      reason: `Matched reasoning keyword "${hit}" -> route to the strongest tier.`,
    };
  }

  if (text.length >= LONG_PROMPT_CHARS) {
    return {
      tier: "balanced",
      reason: `Long prompt (${text.length} chars >= ${LONG_PROMPT_CHARS}) -> mid tier.`,
    };
  }

  return {
    tier: "cheap",
    reason: `Short, non-reasoning prompt (${text.length} chars) -> cheapest tier.`,
  };
}

export interface PickContext {
  /** When false, external models are filtered out and we stay on Workers AI. */
  allowExternal: boolean;
}

/**
 * Pick the cheapest model that clears the requested tier's bar.
 *  - filters out external models unless allowExternal is true
 *  - sorts the remaining candidates by relativeCost (lower wins)
 *  - falls back to the cheapest Workers AI native model if a tier has no
 *    eligible entry (defensive: the shipped catalog always has a native option)
 */
export function pickModel(tier: Tier, ctx: PickContext): ModelEntry {
  const candidates = CATALOG.filter(
    (m) => m.tier === tier && (ctx.allowExternal || !m.external),
  ).sort((a, b) => a.relativeCost - b.relativeCost);

  const chosen = candidates[0];
  if (chosen) return chosen;

  // Workers AI fallback: cheapest native model anywhere in the catalog.
  const nativeFallback = CATALOG.filter((m) => !m.external).sort(
    (a, b) => a.relativeCost - b.relativeCost,
  );
  const fallback = nativeFallback[0];
  if (fallback) return fallback;

  // Unreachable with the shipped catalog, but keeps the return type honest.
  throw new Error("Catalog has no Workers AI native model to fall back to.");
}

/** Narrowing guard for an untrusted tier override coming off the wire. */
export function isTier(value: unknown): value is Tier {
  return value === "cheap" || value === "balanced" || value === "frontier";
}
