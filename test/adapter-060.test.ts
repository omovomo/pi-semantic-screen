import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pythonExceptionsAdapter } from "../src/adapters/python-exceptions.ts";

async function expandedForFirst(root: string): Promise<string> {
  const rich = await pythonExceptionsAdapter.discover({ scope: root, mode: "candidates" });
  assert.equal(rich.status, "ok");
  assert.ok(rich.items?.length);
  const expanded = await pythonExceptionsAdapter.evidence({
    scope: root,
    ids: [rich.items![0].id],
    maxItems: 10,
    maxSources: 4,
    maxChars: 60_000,
    detail: "expanded",
  });
  assert.equal(expanded.status, "ok");
  return expanded.items[0].evidence;
}

test("0.6.0 summarizes exact returned ResultEnvelope fan-out instead of requiring one caller", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-fanout-structured-"));
  try {
    writeFileSync(join(root, "flow.py"), [
      "from dataclasses import dataclass", "", "@dataclass", "class ResultEnvelope:", "    parsed_state: object", "",
      "def parse_state():", "    try:", "        return risky()", "    except Exception:", "        return None", "",
      "def build_input():", "    parsed_state = parse_state()", "    return ResultEnvelope(parsed_state=parsed_state)", "",
      "def evaluate(result_envelope):", "    if result_envelope.parsed_state is None:", "        return 'FAIL_CLOSED'", "    return 'OK'", "",
      "def run_a():", "    result_envelope = build_input()", "    return evaluate(result_envelope)", "",
      "def run_b():", "    result_envelope = build_input()", "    return evaluate(result_envelope)", "",
    ].join("\n"));
    const evidence = await expandedForFirst(root);
    assert.match(evidence, /structured_terminal_flow:.*return_fanout=2 resolved=2 unresolved=0/s);
    assert.match(evidence, /returned_to=run_a\.result_envelope/);
    assert.match(evidence, /returned_to=run_b\.result_envelope/);
    assert.match(evidence, /call=run_[ab]->evaluate binding=result_envelope->result_envelope/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("0.6.0 fan-out reports unresolved consumers instead of treating one resolved branch as universal", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-fanout-partial-"));
  try {
    writeFileSync(join(root, "flow.py"), [
      "from dataclasses import dataclass", "", "@dataclass", "class ResultEnvelope:", "    parsed_state: object", "",
      "def parse_state():", "    try:", "        return risky()", "    except Exception:", "        return None", "",
      "def build_input():", "    parsed_state = parse_state()", "    return ResultEnvelope(parsed_state=parsed_state)", "",
      "def evaluate(result_envelope):", "    if result_envelope.parsed_state is None:", "        return 'FAIL_CLOSED'", "    return 'OK'", "",
      "def run_a():", "    result_envelope = build_input()", "    return evaluate(result_envelope)", "",
      "def run_b():", "    result_envelope = build_input()", "    print(result_envelope)", "    return 'DONE'", "",
    ].join("\n"));
    const evidence = await expandedForFirst(root);
    assert.match(evidence, /return_fanout=2 resolved=1 unresolved=1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("0.6.0 inline helper binding survives returned ResultEnvelope fan-out", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-inline-fanout-"));
  try {
    writeFileSync(join(root, "flow.py"), [
      "from dataclasses import dataclass", "", "@dataclass", "class ResultEnvelope:", "    selected_action: object", "",
      "def selected_action():", "    try:", "        return parse_action()", "    except ValueError:", "        return None", "",
      "def build_input():", "    return ResultEnvelope(selected_action=selected_action())", "",
      "def evaluate(result_envelope):", "    if result_envelope.selected_action is None:", "        return 'UNAVAILABLE'", "    return 'OK'", "",
      "def run_a():", "    result_envelope = build_input()", "    return evaluate(result_envelope)", "",
      "def run_b():", "    result_envelope = build_input()", "    return evaluate(result_envelope)", "",
    ].join("\n"));
    const evidence = await expandedForFirst(root);
    assert.match(evidence, /inline_constructor=ResultEnvelope binding=return->ResultEnvelope\.selected_action/);
    assert.match(evidence, /return_fanout=2 resolved=2 unresolved=0/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("0.6.0 keeps large returned-object fan-out bounded and unresolved", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-large-fanout-"));
  try {
    const callers = Array.from({ length: 9 }, (_, i) => `def run_${i}():\n    result_envelope = build_input()\n    return evaluate(result_envelope)\n`).join("\n");
    writeFileSync(join(root, "flow.py"), [
      "from dataclasses import dataclass", "", "@dataclass", "class ResultEnvelope:", "    state: object", "",
      "def parse_state():", "    try:", "        return risky()", "    except Exception:", "        return None", "",
      "def build_input():", "    state = parse_state()", "    return ResultEnvelope(state=state)", "",
      "def evaluate(result_envelope):", "    if result_envelope.state is None:", "        return 'FAIL_CLOSED'", "    return 'OK'", "",
      callers,
    ].join("\n"));
    const evidence = await expandedForFirst(root);
    assert.match(evidence, /return_fanout=9 unresolved=fanout_exceeds_8/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("0.6.0 handles qualified models.ResultEnvelope returned from a method with multiple callers", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-qualified-method-fanout-"));
  try {
    writeFileSync(join(root, "flow.py"), [
      "from dataclasses import dataclass", "", "@dataclass", "class ResultEnvelope:", "    parsed_state: object", "",
      "class models:", "    ResultEnvelope = ResultEnvelope", "",
      "class Adapter:",
      "    def _parsed_state(self):", "        try:", "            return parse_state()", "        except ValueError:", "            return None", "",
      "    def _build_result_envelope(self):", "        parsed_state = self._parsed_state()", "        return models.ResultEnvelope(parsed_state=parsed_state)", "",
      "    def evaluate(self, result_envelope):", "        if result_envelope.parsed_state is None:", "            return 'FAIL_CLOSED'", "        return 'OK'", "",
      "    def run_a(self):", "        result_envelope = self._build_result_envelope()", "        return self.evaluate(result_envelope)", "",
      "    def run_b(self):", "        result_envelope = self._build_result_envelope()", "        return self.evaluate(result_envelope)", "",
    ].join("\n"));
    const evidence = await expandedForFirst(root);
    assert.match(evidence, /constructor=ResultEnvelope binding=parsed_state->ResultEnvelope\.parsed_state returned_by=_build_result_envelope/);
    assert.match(evidence, /return_fanout=2 resolved=2 unresolved=0/);
    assert.match(evidence, /call=run_[ab]->evaluate binding=result_envelope->result_envelope/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
