import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pythonExceptionsAdapter } from "../src/adapters/python-exceptions.ts";

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-"));
  mkdirSync(join(root, "pkg"));
  writeFileSync(
    join(root, "pkg", "a.py"),
    [
      "def load(path):",
      "    try:",
      "        value = read_data(path)",
      "    except (OSError, ValueError):",
      "        value = None",
      "    return value",
      "",
      "def caller():",
      "    return load('x')",
      "",
      "def second():",
      "    try:",
      "        return risky()",
      "    except RuntimeError:",
      "        return {}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "pkg", "b.py"),
    [
      "def other():",
      "    try:",
      "        run()",
      "    except Exception:",
      "        pass",
      "    return 1",
      "",
    ].join("\n"),
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("python-exceptions adapter count and candidate discovery are deterministic", async () => {
  const { root, cleanup } = fixture();
  try {
    const scope = join(root, "pkg");
    const count = await pythonExceptionsAdapter.discover({ scope, mode: "count" });
    assert.equal(count.status, "ok");
    assert.equal(count.total, 3);
    assert.equal(count.items, undefined);

    const rich = await pythonExceptionsAdapter.discover({ scope, mode: "candidates" });
    assert.equal(rich.status, "ok");
    assert.equal(rich.total, 3);
    assert.equal(rich.items?.length, 3);
    assert.match(rich.items?.[0]?.text ?? "", /scope: load/);
    assert.match(rich.items?.[0]?.text ?? "", /caught: \(OSError, ValueError\)/);
    assert.match(rich.items?.[0]?.text ?? "", /operation: value = read_data\(path\)/);
    assert.match(rich.items?.[0]?.text ?? "", /handler: value = None/);
    assert.match(rich.items?.[0]?.text ?? "", /downstream: return value/);
  } finally {
    cleanup();
  }
});

test("python-exceptions evidence returns exact emitted packet ids and respects source cap", async () => {
  const { root, cleanup } = fixture();
  try {
    const scope = join(root, "pkg");
    const rich = await pythonExceptionsAdapter.discover({ scope, mode: "candidates" });
    assert.equal(rich.status, "ok");
    const ids = rich.items!.map((item) => item.id);

    const packet = await pythonExceptionsAdapter.evidence({
      scope,
      ids,
      maxItems: 80,
      maxSources: 1,
      maxChars: 40_000,
    });
    assert.equal(packet.status, "ok");
    assert.equal(packet.sourceCount, 1);
    assert.equal(packet.packetIds.length, 2);
    assert.deepEqual(packet.packetIds, packet.items.map((item) => item.id));
    assert.ok(packet.packetIds.every((id) => id.includes("a.py:")));
    assert.match(packet.items[0].evidence, /callers:/);
  } finally {
    cleanup();
  }
});

test("python-exceptions adapter fails closed on syntax errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-bad-"));
  try {
    writeFileSync(join(root, "bad.py"), "def broken(:\n    pass\n");
    const result = await pythonExceptionsAdapter.discover({ scope: root, mode: "count" });
    assert.equal(result.status, "error");
    assert.ok((result.issues?.length ?? 0) >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("python-exceptions evidence fails closed on stale ids", async () => {
  const { root, cleanup } = fixture();
  try {
    const scope = join(root, "pkg");
    const packet = await pythonExceptionsAdapter.evidence({
      scope,
      ids: [join(scope, "a.py").replaceAll("\\", "/") + ":999-1000"],
      maxItems: 80,
      maxSources: 10,
      maxChars: 40_000,
    });
    assert.equal(packet.status, "error");
    assert.equal(packet.packetIds.length, 0);
    assert.match(packet.issues?.[0]?.message ?? "", /stale|unresolved/i);
  } finally {
    cleanup();
  }
});
