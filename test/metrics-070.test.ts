import assert from "node:assert/strict";
import test from "node:test";
import { buildScreeningEfficiency } from "../src/metrics.ts";

test("0.7 efficiency metrics distinguish evaluated work from cache reuse", () => {
  const metrics = buildScreeningEfficiency({
    total: 100,
    kept: 20,
    dropped: 60,
    undecided: 10,
    withheld: 5,
    errors: 5,
    retained: 40,
    classifierCalls: 25,
    cacheHits: 75,
    cacheMisses: 25,
    usage: {
      input: 1_000,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1_200,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.012 },
    },
  });

  assert.equal(metrics.discovered, 100);
  assert.equal(metrics.primaryEvaluated, 25);
  assert.equal(metrics.primaryCacheHits, 75);
  assert.equal(metrics.primaryReductionRate, 0.6);
  assert.equal(metrics.reviewAvoidanceRate, 0.6);
  assert.equal(metrics.primaryCacheHitRate, 0.75);
  assert.equal(metrics.classifierTotalTokens, 1_200);
  assert.equal(metrics.classifierCost, 0.012);
});

test("0.7 efficiency metrics do not invent token or monetary precision", () => {
  const metrics = buildScreeningEfficiency({
    total: 4,
    kept: 1,
    dropped: 2,
    undecided: 1,
    withheld: 0,
    errors: 0,
    retained: 2,
    classifierCalls: 4,
    cacheHits: 0,
    cacheMisses: 4,
  });

  assert.equal(metrics.primaryReductionRate, 0.5);
  assert.equal(metrics.reviewAvoidanceRate, 0.5);
  assert.equal(metrics.classifierInputTokens, undefined);
  assert.equal(metrics.classifierOutputTokens, undefined);
  assert.equal(metrics.classifierTotalTokens, undefined);
  assert.equal(metrics.classifierCost, undefined);
});
