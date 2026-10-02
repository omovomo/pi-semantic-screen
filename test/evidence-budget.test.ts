import assert from "node:assert/strict";
import test from "node:test";
import { boundEvidenceByTokens } from "../src/evidence-budget.ts";
import type { AdapterEvidenceResult } from "../src/adapters/types.ts";

function resultWithEvidence(lengths: number[]): AdapterEvidenceResult {
  const items = lengths.map((length, index) => ({
    id: `f.py:${index + 1}-${index + 1}`,
    source: index < 2 ? "f.py" : "g.py",
    evidence: "x".repeat(length),
  }));
  return {
    status: "ok",
    adapter: "test",
    scope: ".",
    requested: items.length,
    packetIds: items.map((item) => item.id),
    sourceCount: 2,
    chars: items.reduce((sum, item) => sum + item.evidence.length, 0),
    items,
  };
}

test("token bound trims only at whole evidence-item boundaries and rewrites exact packet ids", () => {
  const source = resultWithEvidence([400, 400, 400]);
  const bounded = boundEvidenceByTokens(source, 1100, (text) => text.length, { preset: "p" });

  assert.equal(bounded.status, "ok");
  assert.equal(bounded.tokenBudget, 1100);
  assert.ok(bounded.estimatedTokens <= bounded.tokenBudget);
  assert.ok(bounded.items.length >= 1 && bounded.items.length < source.items.length);
  assert.deepEqual(bounded.packetIds, bounded.items.map((item) => item.id));
  assert.equal(bounded.sourceCount, new Set(bounded.items.map((item) => item.source)).size);
  assert.equal(bounded.chars, bounded.items.reduce((sum, item) => sum + item.evidence.length, 0));
});

test("token bound fails closed when one evidence item cannot fit", () => {
  const source = resultWithEvidence([4000]);
  const bounded = boundEvidenceByTokens(source, 1000, (text) => text.length, { preset: "p" });

  assert.equal(bounded.status, "error");
  assert.deepEqual(bounded.packetIds, []);
  assert.deepEqual(bounded.items, []);
  assert.match(bounded.issues?.[0]?.message ?? "", /exceeds token budget/i);
});


test("transport budget includes review-contract overhead", () => {
  const source = resultWithEvidence([250, 250, 250]);
  const withoutContract = boundEvidenceByTokens(source, 1000, (text) => text.length, { preset: "p" });
  const withContract = boundEvidenceByTokens(source, 1000, (text) => text.length, {
    preset: "p",
    reviewContract: { rejectWhen: "r".repeat(300), dispositions: ["CONFIRM", "INSUFFICIENT_EVIDENCE"] },
  });
  assert.ok(withContract.items.length < withoutContract.items.length);
  assert.ok(withContract.estimatedTokens <= withContract.tokenBudget);
});
