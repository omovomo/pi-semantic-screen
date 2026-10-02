import assert from "node:assert/strict";
import test from "node:test";
import { applyReviewDispositions } from "../src/review-apply.ts";

test("review apply validates exact coverage and returns deterministic standard delta", () => {
  const result = applyReviewDispositions({
    packetIds: ["a", "b", "c"],
    detail: "standard",
    dispositions: [
      { id: "a", disposition: "CONFIRM", rationale: "core result silently defaults" },
      { id: "b", disposition: "UI_ONLY", rationale: "display-only stale label" },
      { id: "c", disposition: "INSUFFICIENT_EVIDENCE", rationale: "downstream use not shown" },
    ],
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.evidenceSeenIds, ["a", "b", "c"]);
  assert.deepEqual(result.reviewedIds, ["a", "b"]);
  assert.deepEqual(result.needsExpandedEvidenceIds, ["c"]);
  assert.deepEqual(result.blockedEvidence, []);
  assert.deepEqual(result.findings, [{ id: "a", rationale: "core result silently defaults" }]);
  assert.equal(result.dispositionCounts.CONFIRM, 1);
  assert.equal(result.dispositionCounts.UI_ONLY, 1);
  assert.equal(result.dispositionCounts.INSUFFICIENT_EVIDENCE, 1);
});

test("review apply quarantines expanded insufficient evidence per id", () => {
  const result = applyReviewDispositions({
    packetIds: ["a", "b"],
    detail: "expanded",
    dispositions: [
      { id: "a", disposition: "INSUFFICIENT_EVIDENCE", rationale: "data-flow remains ambiguous" },
      { id: "b", disposition: "EXPLICIT_FAILURE", rationale: "caller receives explicit unavailable state" },
    ],
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.reviewedIds, ["b"]);
  assert.deepEqual(result.needsExpandedEvidenceIds, []);
  assert.deepEqual(result.blockedEvidence, [{ id: "a", rationale: "data-flow remains ambiguous" }]);
});

test("review apply fails closed on missing, duplicate, or extra disposition ids", () => {
  const missing = applyReviewDispositions({
    packetIds: ["a", "b"],
    detail: "standard",
    dispositions: [{ id: "a", disposition: "UI_ONLY", rationale: "ui" }],
  });
  assert.equal(missing.status, "error");
  assert.deepEqual(missing.reviewedIds, []);
  assert.match(missing.issues.join("\n"), /missing disposition id: b/i);

  const duplicate = applyReviewDispositions({
    packetIds: ["a"],
    detail: "standard",
    dispositions: [
      { id: "a", disposition: "UI_ONLY", rationale: "ui" },
      { id: "a", disposition: "UI_ONLY", rationale: "ui again" },
    ],
  });
  assert.equal(duplicate.status, "error");
  assert.match(duplicate.issues.join("\n"), /duplicate disposition id: a/i);

  const extra = applyReviewDispositions({
    packetIds: ["a"],
    detail: "standard",
    dispositions: [
      { id: "a", disposition: "UI_ONLY", rationale: "ui" },
      { id: "x", disposition: "UI_ONLY", rationale: "extra" },
    ],
  });
  assert.equal(extra.status, "error");
  assert.match(extra.issues.join("\n"), /extra disposition id: x/i);
});
