import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getPreset } from "../src/presets/registry.ts";
import { fingerprintClassifierContract } from "../src/cache.ts";
import { parseDeclarativePreset, SIMPLE_PRESET_DEFAULTS_VERSION } from "../src/presets/declarative.ts";
import { registerEvidenceProvider, resolvePresetEvidenceProvider } from "../src/providers/registry.ts";
import { createGenericSourceProvider } from "../src/providers/generic-source.ts";
import type { EvidenceProvider } from "../src/providers/types.ts";

function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "semantic-screen-js-"));
  writeFileSync(path.join(root, "sample.ts"), `
export async function loadConfig() {
  try {
    return await readConfig();
  } catch (error) {
    return {};
  }
}

export const optional = fetchRemote().catch(() => undefined);
`, "utf8");
  return root;
}

test("0.7 shipped JS/TS use case is declarative and uses generic-source provider", async () => {
  const preset = getPreset("js-ts-silent-fallbacks");
  assert.equal(preset.adapter, "generic-source");
  assert.equal(preset.provider?.kind, "generic-source");
  const provider = resolvePresetEvidenceProvider(preset);
  const root = fixture();
  try {
    const discovered = await provider.discover({ scope: root, mode: "candidates" });
    assert.equal(discovered.status, "ok");
    assert.equal(discovered.total, 2);
    assert.equal(discovered.items?.length, 2);
    assert.ok(discovered.items?.every((item) => item.id.startsWith("gs:")));
    assert.ok(discovered.items?.every((item) => item.source?.endsWith("sample.ts")));
    assert.ok(discovered.items?.every((item) => typeof item.line === "number" && typeof item.column === "number"));
    const ids = discovered.items!.map((item) => item.id);
    const evidence = await provider.evidence({ scope: root, ids, maxItems: 10, maxSources: 10, maxChars: 100_000, detail: "standard" });
    assert.equal(evidence.status, "ok");
    assert.deepEqual(evidence.packetIds, ids);
    assert.match(evidence.items[0].evidence, /provider=generic-source/);
    assert.match(evidence.items.map((item) => item.evidence).join("\n"), /return \{\};/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0.7 a new semantic use case can be loaded from a JSON preset path without registry code changes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "semantic-screen-preset-"));
  try {
    const source = getPreset("js-ts-silent-fallbacks");
    const custom = {
      ...source,
      id: "custom-local-audit",
      label: "Custom local audit",
      description: "Local declarative proof",
    };
    const file = path.join(root, "custom.json");
    writeFileSync(file, JSON.stringify(custom), "utf8");
    const loaded = getPreset(file);
    assert.equal(loaded.id, "custom-local-audit");
    assert.equal(loaded.primary.question, source.primary.question);
    assert.equal(loaded.provider?.kind, "generic-source");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("0.7 generic-source fails closed instead of silently skipping an oversized included file", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "semantic-screen-large-"));
  try {
    writeFileSync(path.join(root, "large.ts"), "catch (error) { return {}; }\n".repeat(100), "utf8");
    const provider = createGenericSourceProvider("oversize-proof", {
      include: ["**/*.ts"],
      patterns: [{ id: "catch", regex: "\\bcatch\\s*\\(" }],
      limits: { maxFileBytes: 32 },
    });
    const discovered = await provider.discover({ scope: root, mode: "count" });
    assert.equal(discovered.status, "error");
    assert.match(discovered.issues?.[0]?.message ?? "", /exceeds maxFileBytes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0.7 provider registration rejects unsupported API versions at runtime", () => {
  const invalid = {
    apiVersion: 2,
    id: "future-provider",
    label: "Future provider",
    async discover() { throw new Error("unused"); },
    async evidence() { throw new Error("unused"); },
  } as unknown as EvidenceProvider;
  assert.throws(() => registerEvidenceProvider(invalid), /unsupported semantic-screen provider API version/);
});


test("0.7.1 compact preset normalizes deterministic classifier, review, and budget defaults", () => {
  const preset = parseDeclarativePreset({
    id: "compact-audit",
    source: {
      include: ["**/*.ts"],
      match: ["\\bcatch\\s*\\(", { regex: "\\.catch\\s*\\(", label: "promise catch" }],
    },
    question: "Can a required operation failure become apparently valid default behavior?",
  }, "compact-test");

  assert.equal(SIMPLE_PRESET_DEFAULTS_VERSION, 1);
  assert.equal(preset.id, "compact-audit");
  assert.equal(preset.label, "compact-audit");
  assert.equal(preset.adapter, "generic-source");
  assert.equal(preset.provider?.kind, "generic-source");
  assert.equal(preset.primary.threshold, 0.7);
  assert.match(preset.primary.criteria.true, /answering the semantic question YES/);
  assert.match(preset.review.instructions, /Can a required operation failure/);
  assert.deepEqual(preset.evidence, {
    targetItems: 40,
    maxItems: 60,
    maxSources: 10,
    maxChars: 120000,
    maxTokens: 7200,
  });
  if (preset.provider?.kind !== "generic-source") assert.fail("expected generic-source provider");
  assert.deepEqual(preset.provider.config.patterns.map((entry) => entry.id), ["match-1", "match-2"]);
  assert.deepEqual(preset.provider.config.candidate, { beforeLines: 1, afterLines: 5, maxChars: 3500 });
  assert.deepEqual(preset.provider.config.evidence, {
    standard: { beforeLines: 5, afterLines: 16, maxChars: 12000 },
    expanded: { beforeLines: 16, afterLines: 48, maxChars: 28000 },
  });
  assert.deepEqual(preset.provider.config.limits, { maxFiles: 10000, maxFileBytes: 1000000, maxCandidates: 100000 });
});

test("0.7.1 compact preset supports explicit overrides without requiring advanced boilerplate", () => {
  const preset = parseDeclarativePreset({
    id: "compact-overrides",
    label: "Compact overrides",
    source: {
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      match: [{ id: "catch", regex: "catch", flags: "i" }],
    },
    question: "Could this path hide a required failure?",
    classifier: {
      threshold: 0.8,
      keepWhen: "Evidence plausibly hides the required failure.",
      dropWhen: "Evidence clearly surfaces the failure.",
    },
    evidence: { maxTokens: 4000 },
  }, "compact-overrides-test");

  assert.equal(preset.primary.threshold, 0.8);
  assert.equal(preset.primary.criteria.true, "Evidence plausibly hides the required failure.");
  assert.equal(preset.evidence.maxTokens, 4000);
  assert.equal(preset.evidence.maxItems, 60);
});



test("0.7.2 compact dropHints enrich only the negative classifier criterion and fingerprint", async () => {
  const base = parseDeclarativePreset({
    id: "hint-base",
    source: { include: ["**/*.ts"], match: ["catch"] },
    question: "Could this path hide a required failure?",
  }, "hint-base-test");
  const hinted = parseDeclarativePreset({
    id: "hinted",
    source: { include: ["**/*.ts"], match: ["catch"] },
    question: "Could this path hide a required failure?",
    dropHints: [
      "the handler explicitly rethrows or returns an explicit failure result",
      "the handler performs only cleanup or telemetry without substituting a valid result",
    ],
  }, "hinted-test");

  assert.equal(hinted.primary.criteria.true, base.primary.criteria.true);
  assert.match(hinted.primary.criteria.false, /explicitly rethrows or returns an explicit failure result/);
  assert.match(hinted.primary.criteria.false, /cleanup or telemetry/);
  assert.match(hinted.primary.criteria.false, /Hints are not rules/);
  assert.match(hinted.primary.criteria.false, /ambiguity remains UNDECIDED/);

  const identity = { provider: "test", id: "classifier", implementation: "test-v1" };
  const baseFingerprint = await fingerprintClassifierContract({
    items: [],
    question: base.primary.question,
    criteria: base.primary.criteria,
    threshold: base.primary.threshold,
  }, identity);
  const hintedFingerprint = await fingerprintClassifierContract({
    items: [],
    question: hinted.primary.question,
    criteria: hinted.primary.criteria,
    threshold: hinted.primary.threshold,
  }, identity);
  assert.notEqual(hintedFingerprint, baseFingerprint);
});

test("0.7.2 compact dropHints stay bounded", () => {
  assert.throws(() => parseDeclarativePreset({
    id: "too-many-hints",
    source: { include: ["**/*.ts"], match: ["catch"] },
    question: "Could this path hide a required failure?",
    dropHints: Array.from({ length: 9 }, (_, index) => `hint ${index}`),
  }, "too-many-hints-test"), /at most 8 hints/);

  assert.throws(() => parseDeclarativePreset({
    id: "long-hint",
    source: { include: ["**/*.ts"], match: ["catch"] },
    question: "Could this path hide a required failure?",
    dropHints: ["x".repeat(241)],
  }, "long-hint-test"), /at most 240 characters/);
});

test("0.7.1 compact preset rejects ambiguous mixing with advanced provider/primary form", () => {
  assert.throws(() => parseDeclarativePreset({
    id: "mixed",
    source: { include: ["**/*.ts"], match: ["catch"] },
    question: "question",
    provider: { kind: "builtin", id: "python-exceptions" },
  }, "mixed-test"), /cannot mix source\/question with provider\/primary\/refinement/);
});
