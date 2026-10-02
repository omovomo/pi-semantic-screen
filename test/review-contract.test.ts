import assert from "node:assert/strict";
import test from "node:test";
import { pythonExceptionsPreset } from "../src/presets/python-exceptions.ts";
import { buildReviewContract, REVIEW_DISPOSITION_IDS } from "../src/review-contract.ts";

test("review contract exposes explicit terminal/non-terminal dispositions", () => {
  const contract = buildReviewContract(pythonExceptionsPreset);
  assert.deepEqual(contract.dispositions.map((entry) => entry.id), [...REVIEW_DISPOSITION_IDS]);
  assert.match(contract.rejectWhen, /UI\/display-only/i);
  assert.equal(contract.dispositions.find((entry) => entry.id === "CONFIRM")?.finding, true);
  assert.equal(contract.dispositions.find((entry) => entry.id === "UI_ONLY")?.finding, false);
  assert.equal(contract.dispositions.find((entry) => entry.id === "INSUFFICIENT_EVIDENCE")?.terminal, false);
  assert.match(contract.dispositions.find((entry) => entry.id === "NO_OUTWARD_EFFECT")?.description ?? "", /affirmatively establishes/i);
  assert.match(contract.instructions, /Absence of shown downstream evidence is not proof/i);
  assert.match(contract.rejectWhen, /Missing context is INSUFFICIENT_EVIDENCE/i);
  assert.match(contract.insufficientEvidenceAction, /screen_review_commit.*automatically prioritizes expanded evidence/i);
  assert.match(contract.dispositions.find((entry) => entry.id === "EXPECTED_NORMALIZATION")?.description ?? "", /authoritative record/i);
  assert.match(contract.confirmWhen, /authoritative source record/i);
  assert.match(contract.rejectWhen, /malformed authoritative lot\/transaction\/record/i);
});

test("review contract stays compact while retaining fail-closed semantic rules", () => {
  const contract = buildReviewContract(pythonExceptionsPreset);
  const serialized = JSON.stringify(contract);
  assert.ok(serialized.length <= 2700, `review contract too large: ${serialized.length} bytes`);
  assert.match(contract.confirmWhen, /authoritative source record/i);
  assert.match(contract.confirmWhen, /persisted-state read\/parse/i);
  assert.match(contract.rejectWhen, /malformed authoritative lot\/transaction\/record/i);
  assert.match(contract.rejectWhen, /Missing context is INSUFFICIENT_EVIDENCE/i);
});
