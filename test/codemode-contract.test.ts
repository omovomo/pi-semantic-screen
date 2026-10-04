import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../extensions/screen.ts", import.meta.url), "utf8");

test("extension exposes screening and extension-owned review tools", () => {
  for (const name of [
    "screen_preset",
    "screen_discover",
    "screen_primary_start",
    "screen_primary_manifest",
    "screen_refinement_start",
    "screen_evidence",
    "screen_review_apply",
    "screen_review_start",
    "screen_review_next",
    "screen_review_commit",
    "screen_preflight",
    "screen_batch",
  ]) assert.match(source, new RegExp(`name:\\s*"${name}"`));
  assert.match(source, /primaryStartOutputSchema/);
  assert.match(source, /primaryManifestOutputSchema/);
  assert.match(source, /refinementStartOutputSchema/);
  assert.match(source, /PresetScreeningWorkflowManager/);
  assert.match(source, /exactPresetStageInput/);
  assert.match(source, /reviewStartOutputSchema/);
  assert.match(source, /reviewNextOutputSchema/);
  assert.match(source, /reviewCommitOutputSchema/);
  assert.match(source, /ReviewWorkflowManager/);
  assert.match(source, /structuredContent:\s*result/);
  assert.match(source, /runWithClassificationCache/);
  assert.match(source, /classifierAccounting/);
  assert.doesNotMatch(source, /@garygentry\/system1-pi|decide\.exe|\bspawn(?:Sync)?\([^\n]*["\']decide["\']/i);
});

test("extension defers context compaction to host and preserves extension-owned review semantics", () => {
  assert.match(source, /PI_SEMANTIC_SCREEN_COMPACT_THRESHOLD/);
  assert.match(source, /pi\.on\("session_start"/);
  assert.match(source, /reviewWorkflows\.reset\(\)/);
  assert.match(source, /pi\.on\("turn_end"/);
  assert.match(source, /ctx\.compact\(\{/);
  assert.match(source, /Exact review accounting lives in the extension-owned review workflow state/i);
});

test("screen_evidence remains token-bounded and contract-carrying", () => {
  assert.match(source, /maxTokens: Type\.Optional/);
  assert.match(source, /tokenBudget: Type\.Integer/);
  assert.match(source, /estimatedTokens: Type\.Integer/);
  assert.match(source, /trimmed: Type\.Boolean/);
  assert.match(source, /buildEvidencePacket/);
  assert.match(source, /boundEvidenceByTokens/);
  assert.match(source, /buildReviewContract/);
});

test("stateful review tools start, return idempotent pending packets, and commit atomically", () => {
  assert.match(source, /reviewWorkflows\.start\(/);
  assert.match(source, /reviewWorkflows\.next\(/);
  assert.match(source, /reviewWorkflows\.commit\(/);
  assert.match(source, /name:\s*"screen_review_next"[\s\S]*?executionMode:\s*"sequential"/);
  assert.match(source, /name:\s*"screen_review_commit"[\s\S]*?executionMode:\s*"sequential"/);
  assert.match(source, /Omit workflowId to resume the latest workflow/i);
  assert.match(source, /Atomically validate dispositions/i);
  assert.match(source, /reviewDecisionTupleSchema = Type\.Tuple/);
  assert.match(source, /reviewDecisionCommitSchema = Type\.Union/);
  assert.match(source, /name:\s*"screen_review_next"[\s\S]*?const text = JSON\.stringify\(result\)/);
  assert.match(source, /name:\s*"screen_review_commit"[\s\S]*?const text = JSON\.stringify\(result\)/);
});


test("canonical preset screening never accepts model-supplied semantic contracts", () => {
  assert.match(source, /name:\s*"screen_primary_start"[\s\S]*?parameters:\s*primaryStartParameters/);
  assert.match(source, /name:\s*"screen_primary_manifest"[\s\S]*?parameters:\s*primaryManifestParameters/);
  assert.match(source, /name:\s*"screen_refinement_start"[\s\S]*?parameters:\s*refinementStartParameters/);
  const primarySchema = source.slice(
    source.indexOf("const primaryStartParameters"),
    source.indexOf("const primaryStartOutputSchema"),
  );
  assert.doesNotMatch(primarySchema, /question:/);
  assert.doesNotMatch(primarySchema, /criteria:/);
  assert.doesNotMatch(primarySchema, /threshold:/);
  assert.match(source, /contractSource:\s*"preset"/);
  assert.match(source, /classificationCache\.clear\(\)/);
});
