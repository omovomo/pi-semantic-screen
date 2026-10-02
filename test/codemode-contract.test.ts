import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../extensions/screen.ts", import.meta.url), "utf8");

test("extension exposes preset, adapter, preflight and classifier tools with structured output for Code Mode", () => {
  assert.match(source, /name:\s*"screen_preset"/);
  assert.match(source, /name:\s*"screen_discover"/);
  assert.match(source, /name:\s*"screen_evidence"/);
  assert.match(source, /name:\s*"screen_preflight"/);
  assert.match(source, /name:\s*"screen_batch"/);
  assert.match(source, /presetOutputSchema/);
  assert.match(source, /discoverOutputSchema/);
  assert.match(source, /evidenceOutputSchema/);
  assert.match(source, /preflightOutputSchema/);
  assert.match(source, /outputSchema,/);
  assert.match(source, /structuredContent:\s*structuredResult/);
  assert.match(source, /rescreen:/);
  assert.match(source, /runWithScreeningCache/);
  assert.match(source, /classifierAccounting/);
  assert.match(source, /accounting\?\.complete/);
  assert.match(source, /\.\.\.\(toolUsage \? \{ usage: toolUsage \} : \{\}\)/);
  assert.doesNotMatch(source, /@garygentry\/system1-pi|decide\.exe|\bspawn(?:Sync)?\([^\n]*["\']decide["\']/i);
});


test("extension defers context compaction to the host unless explicitly configured", () => {
  assert.match(source, /PI_SEMANTIC_SCREEN_COMPACT_THRESHOLD/);
  assert.match(source, /parseNonNegativeEnvInt\([\s\S]*?PI_SEMANTIC_SCREEN_COMPACT_THRESHOLD[\s\S]*?\n\s*0,/);
  assert.match(source, /pi\.on\("before_agent_start"/);
  assert.match(source, /isSemanticScreenPrompt\(event\.prompt\)/);
  assert.match(source, /pi\.on\("turn_end"/);
  assert.match(source, /ctx\.getContextUsage\(\)/);
  assert.match(source, /ctx\.compact\(\{/);
  assert.match(source, /Drop superseded raw evidence\/source excerpts/);
  assert.match(source, /if \(completed\) semanticScreenWorkflowActive = false/);
});

test("screen_evidence exposes a transport token budget and exact post-trim accounting", () => {
  assert.match(source, /maxTokens: Type\.Optional/);
  assert.match(source, /tokenBudget: Type\.Integer/);
  assert.match(source, /estimatedTokens: Type\.Integer/);
  assert.match(source, /boundEvidenceByTokens/);
  assert.match(source, /preset\.evidence\.maxTokens/);
});
