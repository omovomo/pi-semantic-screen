import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getPreset } from "../src/presets/registry.ts";
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
