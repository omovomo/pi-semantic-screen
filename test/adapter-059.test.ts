import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pythonExceptionsAdapter } from "../src/adapters/python-exceptions.ts";

test("0.5.9 follows fallback through a directly returned ResultEnvelope into evaluator", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-direct-return-structured-"));
  try {
    writeFileSync(join(root, "flow.py"), [
      "from dataclasses import dataclass", "", "@dataclass", "class ResultEnvelope:", "    parsed_state: object", "",
      "def parse_state():", "    try:", "        return risky()", "    except Exception:", "        return None", "",
      "def build_input():", "    parsed_state = parse_state()", "    return ResultEnvelope(parsed_state=parsed_state)", "",
      "def evaluate(result_envelope):", "    if result_envelope.parsed_state is None:", "        return 'FAIL_CLOSED'", "    return 'OK'", "",
      "def run():", "    result_envelope = build_input()", "    return evaluate(result_envelope)", ""
    ].join("\n"));
    const rich = await pythonExceptionsAdapter.discover({ scope: root, mode: "candidates" });
    const expanded = await pythonExceptionsAdapter.evidence({ scope: root, ids: [rich.items![0].id], maxItems: 10, maxSources: 2, maxChars: 40_000, detail: "expanded" });
    const evidence = expanded.items[0].evidence;
    assert.match(evidence, /constructor=ResultEnvelope binding=parsed_state->ResultEnvelope\.parsed_state returned_by=build_input/);
    assert.match(evidence, /returned_to=run\.result_envelope/);
    assert.match(evidence, /call=run->evaluate binding=result_envelope->result_envelope/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("0.5.9 binds inline fallback helper directly into returned constructor field", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-inline-structured-"));
  try {
    writeFileSync(join(root, "flow.py"), [
      "from dataclasses import dataclass", "", "@dataclass", "class ResultEnvelope:", "    selected_action: object", "",
      "def selected_action():", "    try:", "        return parse_action()", "    except ValueError:", "        return None", "",
      "def build_input():", "    return ResultEnvelope(selected_action=selected_action())", "",
      "def evaluate(result_envelope):", "    if result_envelope.selected_action is None:", "        return 'UNAVAILABLE'", "    return 'OK'", "",
      "def run():", "    result_envelope = build_input()", "    return evaluate(result_envelope)", ""
    ].join("\n"));
    const rich = await pythonExceptionsAdapter.discover({ scope: root, mode: "candidates" });
    const expanded = await pythonExceptionsAdapter.evidence({ scope: root, ids: [rich.items![0].id], maxItems: 10, maxSources: 2, maxChars: 40_000, detail: "expanded" });
    const evidence = expanded.items[0].evidence;
    assert.match(evidence, /inline_constructor=ResultEnvelope binding=return->ResultEnvelope\.selected_action/);
    assert.match(evidence, /returned_to=run\.result_envelope/);
    assert.match(evidence, /call=run->evaluate binding=result_envelope->result_envelope/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("0.5.9 follows one exact evaluator result into its immediate returned result", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-terminal-result-hop-"));
  try {
    writeFileSync(join(root, "flow.py"), [
      "from dataclasses import dataclass", "", "@dataclass", "class Report:", "    proposed_state: object", "", "@dataclass", "class Snapshot:", "    state: object", "",
      "def parse_state():", "    try:", "        return parse_raw()", "    except ValueError:", "        return None", "",
      "def transition(report):", "    if report.proposed_state is None:", "        return 'HARD_FAILURE'", "    return report.proposed_state", "",
      "def resolve():", "    raw_state = parse_state()", "    report = Report(proposed_state=raw_state)", "    state = transition(report)", "    return Snapshot(state=state)", ""
    ].join("\n"));
    const rich = await pythonExceptionsAdapter.discover({ scope: root, mode: "candidates" });
    const expanded = await pythonExceptionsAdapter.evidence({ scope: root, ids: [rich.items![0].id], maxItems: 10, maxSources: 2, maxChars: 40_000, detail: "expanded" });
    const evidence = expanded.items[0].evidence;
    assert.match(evidence, /terminal_result=transition return->state/);
    assert.match(evidence, /returned_container_binding=state->Snapshot\.state/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("expanded structured terminal flow rejects structural result branches without explicit bounded outcome", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-structured-false-positive-"));
  try {
    writeFileSync(
      join(root, "flow.py"),
      [
        "def iter_context(context_map):",
        "    if isinstance(context_map, dict):",
        "        for key in context_map:",
        "            yield key",
        "    yield 'done'",
        "",
        "def build_context_fingerprint():",
        "    try:",
        "        context_map = load_context()",
        "    except Exception:",
        "        context_map = {}",
        "    values = list(iter_context(context_map))",
        "    return values",
        "",
      ].join("\n"),
    );
    const rich = await pythonExceptionsAdapter.discover({ scope: root, mode: "candidates" });
    const expanded = await pythonExceptionsAdapter.evidence({
      scope: root,
      ids: [rich.items![0].id],
      maxItems: 10,
      maxSources: 2,
      maxChars: 40_000,
      detail: "expanded",
    });
    const evidence = expanded.items[0].evidence;
    assert.match(evidence, /structured_terminal_flow: <none>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

