import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pythonExceptionsAdapter } from "../src/adapters/python-exceptions.ts";

test("0.5.9 follows fallback through a directly returned PolicyInput into evaluator", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-direct-return-policy-"));
  try {
    writeFileSync(join(root, "flow.py"), [
      "from dataclasses import dataclass", "", "@dataclass", "class PolicyInput:", "    allocation_state: object", "",
      "def classify_allocation():", "    try:", "        return risky()", "    except Exception:", "        return None", "",
      "def build_input():", "    allocation_state = classify_allocation()", "    return PolicyInput(allocation_state=allocation_state)", "",
      "def evaluate(policy_input):", "    if policy_input.allocation_state is None:", "        return 'FAIL_CLOSED'", "    return 'OK'", "",
      "def run():", "    policy_input = build_input()", "    return evaluate(policy_input)", ""
    ].join("\n"));
    const rich = await pythonExceptionsAdapter.discover({ scope: root, mode: "candidates" });
    const expanded = await pythonExceptionsAdapter.evidence({ scope: root, ids: [rich.items![0].id], maxItems: 10, maxSources: 2, maxChars: 40_000, detail: "expanded" });
    const evidence = expanded.items[0].evidence;
    assert.match(evidence, /constructor=PolicyInput binding=allocation_state->PolicyInput\.allocation_state returned_by=build_input/);
    assert.match(evidence, /returned_to=run\.policy_input/);
    assert.match(evidence, /call=run->evaluate binding=policy_input->policy_input/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("0.5.9 binds inline fallback helper directly into returned constructor field", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-inline-policy-"));
  try {
    writeFileSync(join(root, "flow.py"), [
      "from dataclasses import dataclass", "", "@dataclass", "class PolicyInput:", "    holding_action: object", "",
      "def holding_action():", "    try:", "        return parse_action()", "    except ValueError:", "        return None", "",
      "def build_input():", "    return PolicyInput(holding_action=holding_action())", "",
      "def evaluate(policy_input):", "    if policy_input.holding_action is None:", "        return 'UNAVAILABLE'", "    return 'OK'", "",
      "def run():", "    policy_input = build_input()", "    return evaluate(policy_input)", ""
    ].join("\n"));
    const rich = await pythonExceptionsAdapter.discover({ scope: root, mode: "candidates" });
    const expanded = await pythonExceptionsAdapter.evidence({ scope: root, ids: [rich.items![0].id], maxItems: 10, maxSources: 2, maxChars: 40_000, detail: "expanded" });
    const evidence = expanded.items[0].evidence;
    assert.match(evidence, /inline_constructor=PolicyInput binding=return->PolicyInput\.holding_action/);
    assert.match(evidence, /returned_to=run\.policy_input/);
    assert.match(evidence, /call=run->evaluate binding=policy_input->policy_input/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("0.5.9 follows one exact evaluator result into its immediate returned snapshot", async () => {
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
test("expanded policy terminal flow rejects structural snapshot branches without explicit bounded outcome", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-policy-false-positive-"));
  try {
    writeFileSync(
      join(root, "flow.py"),
      [
        "def iter_snapshot_context(snapshots):",
        "    if isinstance(snapshots, dict):",
        "        for key in snapshots:",
        "            yield key",
        "    yield 'done'",
        "",
        "def build_policy_snapshot_fingerprint():",
        "    try:",
        "        snapshots = load_snapshots()",
        "    except Exception:",
        "        snapshots = {}",
        "    values = list(iter_snapshot_context(snapshots))",
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
    assert.match(evidence, /policy_terminal_flow: <none>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

