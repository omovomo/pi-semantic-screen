import assert from "node:assert/strict";
import test from "node:test";
import {
  ScreeningResultCache,
  fingerprintScreeningInput,
  runWithScreeningCache,
} from "../src/cache.ts";
import type { ScreeningInput, ScreeningResult } from "../src/engine.ts";

function okResult(probability: number): ScreeningResult {
  return {
    status: "ok",
    model: { provider: "fake", id: "jev" },
    summary: {
      total: 1,
      kept: 1,
      dropped: 0,
      undecided: 0,
      withheld: 0,
      errors: 0,
      redactedItems: 0,
      redactionCount: 0,
    },
    kept: [{ id: "x", probability }],
    dropped: [],
    undecided: [],
    withheld: [],
    errors: [],
  };
}

const baseInput: ScreeningInput = {
  items: [{ id: "x", text: "candidate source" }],
  question: "keep?",
  confirm: true,
};

test("fingerprint ignores rescreen but preserves guard-confirm semantics", async () => {
  const base = await fingerprintScreeningInput(baseInput);
  const fresh = await fingerprintScreeningInput({ ...baseInput, rescreen: true });
  const unconfirmed = await fingerprintScreeningInput({ ...baseInput, confirm: false });
  assert.equal(base, fresh);
  assert.notEqual(base, unconfirmed);
});

test("identical successful screening is reused without another classifier run", async () => {
  const cache = new ScreeningResultCache(4);
  let runs = 0;
  const run = async () => {
    runs += 1;
    return okResult(runs === 1 ? 0.91 : 0.73);
  };

  const first = await runWithScreeningCache(baseInput, cache, run);
  const second = await runWithScreeningCache(baseInput, cache, run);

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(runs, 1);
  assert.equal(second.result.kept[0]?.probability, 0.91);
});

test("rescreen=true bypasses reuse and refreshes the canonical cached result", async () => {
  const cache = new ScreeningResultCache(4);
  let runs = 0;
  const run = async () => {
    runs += 1;
    return okResult(runs === 1 ? 0.91 : 0.73);
  };

  await runWithScreeningCache(baseInput, cache, run);
  const fresh = await runWithScreeningCache({ ...baseInput, rescreen: true }, cache, run);
  const after = await runWithScreeningCache(baseInput, cache, run);

  assert.equal(fresh.reused, false);
  assert.equal(after.reused, true);
  assert.equal(runs, 2);
  assert.equal(after.result.kept[0]?.probability, 0.73);
});

test("approval_required is never cached as a successful screening", async () => {
  const cache = new ScreeningResultCache(4);
  let runs = 0;
  const approval: ScreeningResult = {
    status: "approval_required",
    summary: {
      total: 201,
      kept: 0,
      dropped: 0,
      undecided: 0,
      withheld: 201,
      errors: 0,
      redactedItems: 0,
      redactionCount: 0,
    },
    kept: [],
    dropped: [],
    undecided: [],
    withheld: Array.from({ length: 201 }, (_, index) => ({
      id: `i${index}`,
      reason: "approval_required" as const,
    })),
    errors: [],
    projectedCalls: 201,
    callLimit: 200,
  };
  const input: ScreeningInput = {
    items: Array.from({ length: 201 }, (_, index) => ({ id: `i${index}`, text: "x" })),
    question: "keep?",
  };
  const run = async () => {
    runs += 1;
    return approval;
  };

  const first = await runWithScreeningCache(input, cache, run);
  const second = await runWithScreeningCache(input, cache, run);

  assert.equal(first.reused, false);
  assert.equal(second.reused, false);
  assert.equal(runs, 2);
});
