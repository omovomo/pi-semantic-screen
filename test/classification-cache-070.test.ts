import assert from "node:assert/strict";
import test from "node:test";
import { ClassificationResultCache, fingerprintClassifierContract, runWithClassificationCache } from "../src/cache.ts";
import type { ScreeningInput, ScreeningResult } from "../src/engine.ts";

function resultFor(input: ScreeningInput): ScreeningResult {
  return {
    status: "ok",
    model: { provider: input.provider!, id: input.model! },
    summary: {
      total: input.items.length,
      kept: input.items.length,
      dropped: 0,
      undecided: 0,
      withheld: 0,
      errors: 0,
      redactedItems: 0,
      redactionCount: 0,
    },
    kept: input.items.map((item) => ({ id: item.id, probability: 0.91 })),
    dropped: [], undecided: [], withheld: [], errors: [],
    classifierAccounting: { calls: input.items.length, usageReportedCalls: 0, complete: false },
  };
}

const identity = { provider: "test", id: "cheap-1", implementation: "classifier-v1" };
const input: ScreeningInput = {
  items: [{ id: "a", text: "alpha" }, { id: "b", text: "beta" }],
  question: "retain?",
  criteria: { true: "yes", false: "no" },
  threshold: 0.7,
  provider: identity.provider,
  model: identity.id,
  confirm: true,
};

test("0.7 classification cache reuses unchanged candidates and recomputes only changed candidates", async () => {
  const cache = new ClassificationResultCache();
  const calls: string[][] = [];
  const run = async (miss: ScreeningInput) => { calls.push(miss.items.map((item) => item.id)); return resultFor(miss); };

  const first = await runWithClassificationCache(input, identity, cache, run);
  const second = await runWithClassificationCache({ ...input, items: [{ id: "a", text: "alpha" }, { id: "b", text: "beta changed" }] }, identity, cache, run);

  assert.equal(first.cacheHits, 0);
  assert.equal(first.cacheMisses, 2);
  assert.equal(second.cacheHits, 1);
  assert.equal(second.cacheMisses, 1);
  assert.deepEqual(calls, [["a", "b"], ["b"]]);
  assert.equal(second.result.summary.total, 2);
  assert.equal(second.result.classifierAccounting?.calls, 1);
});

test("0.7 classification cache invalidates on classifier identity or semantic contract change", async () => {
  const cache = new ClassificationResultCache();
  let evaluated = 0;
  const run = async (miss: ScreeningInput) => { evaluated += miss.items.length; return resultFor(miss); };
  await runWithClassificationCache(input, identity, cache, run);
  const newModel = await runWithClassificationCache(input, { ...identity, id: "cheap-2" }, cache, run);
  const newQuestion = await runWithClassificationCache({ ...input, question: "different semantic question?" }, identity, cache, run);
  assert.equal(newModel.cacheHits, 0);
  assert.equal(newQuestion.cacheHits, 0);
  assert.equal(evaluated, 6);
});


test("0.8 classification cache contract includes explicit DROP threshold", async () => {
  const identity = { provider: "fake", id: "classifier", implementation: "v1" };
  const base = {
    items: [{ id: "x", text: "candidate" }],
    question: "keep?",
    keepThreshold: 0.7,
    dropThreshold: 0.2,
  };
  const a = await fingerprintClassifierContract(base, identity);
  const b = await fingerprintClassifierContract({ ...base, dropThreshold: 0.1 }, identity);
  assert.notEqual(a, b);
});
