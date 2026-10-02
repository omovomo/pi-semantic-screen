import assert from "node:assert/strict";
import test from "node:test";
import { getAdapter, listAdapters } from "../src/adapters/registry.ts";
import { getPreset, listPresets } from "../src/presets/registry.ts";


test("python-exceptions preset resolves through the adapter registry", () => {
  const preset = getPreset("python-exceptions");
  const adapter = getAdapter(preset.adapter);
  assert.equal(adapter.id, "python-exceptions");
  assert.equal(preset.primary.threshold, 0.70);
  assert.equal(preset.refinement?.threshold, 0.75);
  assert.equal(preset.evidence.maxSources, 10);
  assert.equal(preset.evidence.maxChars, 40_000);
});

test("preset and adapter registries list stable public ids", () => {
  assert.ok(listPresets().some((preset) => preset.id === "python-exceptions"));
  assert.ok(listAdapters().some((adapter) => adapter.id === "python-exceptions"));
});
