import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pythonExceptionsAdapter } from "../src/adapters/python-exceptions.ts";

test("0.6.2 expanded evidence handles module-level exception handlers", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-module-handler-"));
  try {
    writeFileSync(join(root, "flow.py"), [
      "try:",
      "    import missing_optional_dependency",
      "except ImportError:",
      "    FEATURE_AVAILABLE = False",
      "",
      "VALUE = 1",
    ].join("\n"));

    const discovered = await pythonExceptionsAdapter.discover({ scope: root, mode: "candidates" });
    assert.equal(discovered.status, "ok");
    assert.equal(discovered.items?.length, 1);

    const expanded = await pythonExceptionsAdapter.evidence({
      scope: root,
      ids: [discovered.items![0].id],
      maxItems: 10,
      maxSources: 4,
      maxChars: 60_000,
      detail: "expanded",
    });

    assert.equal(expanded.status, "ok");
    assert.equal(expanded.items.length, 1);
    assert.match(expanded.items[0].evidence, /scope: <module>/);
    assert.match(expanded.items[0].evidence, /handler_control_flow:/);
    assert.match(expanded.items[0].evidence, /fallthrough=yes/);
    assert.match(expanded.items[0].evidence, /fallthrough_target=VALUE = 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
