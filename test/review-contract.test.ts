import assert from "node:assert/strict";
import test from "node:test";
import { pythonExceptionsPreset } from "../src/presets/python-exceptions.ts";
import { buildReviewContract, genericReviewContract } from "../src/review-contract.ts";
import { parseDeclarativePreset } from "../src/presets/declarative.ts";

test("generic review contract is language- and domain-neutral", () => {
  const contract = genericReviewContract();
  assert.deepEqual(contract.dispositions.map((entry) => entry.id), ["CONFIRM", "REJECT", "INSUFFICIENT_EVIDENCE"]);
  const serialized = JSON.stringify(contract).toLowerCase();
  for (const forbidden of ["python", "javascript", "exception", "fallback", "ui_only", "telemetry", "normalization"]) {
    assert.equal(serialized.includes(forbidden), false, `generic review contract leaked domain term: ${forbidden}`);
  }
});

test("compact declarative presets receive the neutral generic review contract", () => {
  const preset = parseDeclarativePreset({
    id: "neutral",
    source: { include: ["**/*.txt"], match: ["candidate"] },
    question: "Does this candidate satisfy the requested property?",
  });
  const contract = buildReviewContract(preset);
  assert.deepEqual(contract.dispositions.map((entry) => entry.id), ["CONFIRM", "REJECT", "INSUFFICIENT_EVIDENCE"]);
});

test("advanced providers may own domain-specific terminal dispositions without leaking them into core", () => {
  const contract = buildReviewContract(pythonExceptionsPreset);
  assert.ok(contract.dispositions.some((entry) => entry.id === "UI_ONLY"));
  assert.ok(contract.dispositions.some((entry) => entry.id === "EXPLICIT_FAILURE"));
  assert.equal(genericReviewContract().dispositions.some((entry) => entry.id === "UI_ONLY"), false);
  assert.equal(contract.dispositions.find((entry) => entry.id === "CONFIRM")?.finding, true);
  assert.equal(contract.dispositions.find((entry) => entry.id === "INSUFFICIENT_EVIDENCE")?.terminal, false);
});


test("advanced review vocabulary remains fail-closed and binary for findings", () => {
  const base = parseDeclarativePreset({
    id: "custom-review",
    label: "Custom review",
    description: "Custom review proof",
    provider: { kind: "generic-source", config: { include: ["**/*.txt"], patterns: [{ id: "x", regex: "x" }] } },
    primary: { question: "Q?", criteria: { true: "yes", false: "no" }, threshold: 0.7 },
    review: {
      instructions: "Use evidence only.",
      confirmWhen: "Confirm yes.",
      rejectWhen: "Reject no.",
      dispositions: [
        { id: "CONFIRM", terminal: true, finding: true, description: "yes" },
        { id: "SAFE_VARIANT", terminal: true, finding: false, description: "no by a domain-specific reason" },
        { id: "INSUFFICIENT_EVIDENCE", terminal: false, finding: false, description: "unknown" },
      ],
    },
    evidence: { targetItems: 1, maxItems: 1, maxSources: 1, maxChars: 1000, maxTokens: 1000 },
  });
  assert.doesNotThrow(() => buildReviewContract(base));

  base.review.dispositions![1] = { id: "SECOND_FINDING", terminal: true, finding: true, description: "ambiguous second positive class" };
  assert.throws(() => buildReviewContract(base), /only CONFIRM may be a finding disposition/);
});
