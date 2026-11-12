import assert from "node:assert/strict";
import test from "node:test";

import { CATALOG, classify, isTier, pickModel } from "../src/router.ts";

test("classify routes short, simple prompts to the cheap tier", () => {
  assert.equal(classify("Write a haiku.").tier, "cheap");
});

test("classify routes long prompts to the balanced tier", () => {
  assert.equal(classify("x".repeat(400)).tier, "balanced");
});

test("reasoning keywords take priority over prompt length", () => {
  assert.equal(classify(`Explain ${"x".repeat(400)}`).tier, "frontier");
});

test("pickModel chooses the cheapest eligible model in each tier", () => {
  for (const tier of ["cheap", "balanced", "frontier"] as const) {
    const expected = CATALOG.filter(
      (model) => model.tier === tier && !model.external,
    ).sort((a, b) => a.relativeCost - b.relativeCost)[0];

    assert.equal(pickModel(tier, { allowExternal: false }).id, expected.id);
  }
});

test("isTier rejects untrusted values", () => {
  assert.equal(isTier("frontier"), true);
  assert.equal(isTier("unknown"), false);
  assert.equal(isTier(null), false);
});
