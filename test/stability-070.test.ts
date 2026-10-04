import assert from "node:assert/strict";
import test from "node:test";
import { compareSemanticManifests } from "../src/stability.ts";

test("0.7 semantic stability comparison reports generic disposition transitions", () => {
  const summary = compareSemanticManifests(
    [
      { id: "a", disposition: "CONFIRM" },
      { id: "b", disposition: "BLOCKED_EVIDENCE" },
      { id: "c", disposition: "UI_ONLY" },
    ],
    [
      { id: "a", disposition: "CONFIRM" },
      { id: "b", disposition: "UI_ONLY" },
      { id: "c", disposition: "CONFIRM" },
      { id: "d", disposition: "BLOCKED_EVIDENCE" },
    ],
  );
  assert.equal(summary.commonCandidateIds, 3);
  assert.equal(summary.stableDisposition, 1);
  assert.equal(summary.changedDisposition, 2);
  assert.equal(summary.stability, 1 / 3);
  assert.equal(summary.stableConfirm, 1);
  assert.equal(summary.newConfirm, 1);
  assert.equal(summary.resolvedBlocked, 1);
  assert.equal(summary.newBlocked, 1);
});
