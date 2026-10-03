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

test("0.6.0 summarizes exact returned PolicyInput fan-out instead of requiring one caller", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-fanout-policy-"));
  try {
    writeFileSync(join(root, "flow.py"), [
      "from dataclasses import dataclass", "", "@dataclass", "class PolicyInput:", "    allocation_state: object", "",
      "def classify_allocation():", "    try:", "        return risky()", "    except Exception:", "        return None", "",
      "def build_input():", "    allocation_state = classify_allocation()", "    return PolicyInput(allocation_state=allocation_state)", "",
      "def evaluate(policy_input):", "    if policy_input.allocation_state is None:", "        return 'FAIL_CLOSED'", "    return 'OK'", "",
      "def run_a():", "    policy_input = build_input()", "    return evaluate(policy_input)", "",
      "def run_b():", "    policy_input = build_input()", "    return evaluate(policy_input)", "",
    ].join("\n"));
    const evidence = await expandedForFirst(root);
    assert.match(evidence, /policy_terminal_flow:.*return_fanout=2 resolved=2 unresolved=0/s);
    assert.match(evidence, /returned_to=run_a\.policy_input/);
    assert.match(evidence, /returned_to=run_b\.policy_input/);
    assert.match(evidence, /call=run_[ab]->evaluate binding=policy_input->policy_input/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("0.6.0 fan-out reports unresolved consumers instead of treating one resolved branch as universal", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-fanout-partial-"));
  try {
    writeFileSync(join(root, "flow.py"), [
      "from dataclasses import dataclass", "", "@dataclass", "class PolicyInput:", "    allocation_state: object", "",
      "def classify_allocation():", "    try:", "        return risky()", "    except Exception:", "        return None", "",
      "def build_input():", "    allocation_state = classify_allocation()", "    return PolicyInput(allocation_state=allocation_state)", "",
      "def evaluate(policy_input):", "    if policy_input.allocation_state is None:", "        return 'FAIL_CLOSED'", "    return 'OK'", "",
      "def run_a():", "    policy_input = build_input()", "    return evaluate(policy_input)", "",
      "def run_b():", "    policy_input = build_input()", "    print(policy_input)", "    return 'DONE'", "",
    ].join("\n"));
    const evidence = await expandedForFirst(root);
    assert.match(evidence, /return_fanout=2 resolved=1 unresolved=1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("0.6.0 inline helper binding survives returned PolicyInput fan-out", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-inline-fanout-"));
  try {
    writeFileSync(join(root, "flow.py"), [
      "from dataclasses import dataclass", "", "@dataclass", "class PolicyInput:", "    holding_action: object", "",
      "def holding_action():", "    try:", "        return parse_action()", "    except ValueError:", "        return None", "",
      "def build_input():", "    return PolicyInput(holding_action=holding_action())", "",
      "def evaluate(policy_input):", "    if policy_input.holding_action is None:", "        return 'UNAVAILABLE'", "    return 'OK'", "",
      "def run_a():", "    policy_input = build_input()", "    return evaluate(policy_input)", "",
      "def run_b():", "    policy_input = build_input()", "    return evaluate(policy_input)", "",
    ].join("\n"));
    const evidence = await expandedForFirst(root);
    assert.match(evidence, /inline_constructor=PolicyInput binding=return->PolicyInput\.holding_action/);
    assert.match(evidence, /return_fanout=2 resolved=2 unresolved=0/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("0.6.0 keeps large returned-object fan-out bounded and unresolved", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-large-fanout-"));
  try {
    const callers = Array.from({ length: 9 }, (_, i) => `def run_${i}():\n    policy_input = build_input()\n    return evaluate(policy_input)\n`).join("\n");
    writeFileSync(join(root, "flow.py"), [
      "from dataclasses import dataclass", "", "@dataclass", "class PolicyInput:", "    state: object", "",
      "def parse_state():", "    try:", "        return risky()", "    except Exception:", "        return None", "",
      "def build_input():", "    state = parse_state()", "    return PolicyInput(state=state)", "",
      "def evaluate(policy_input):", "    if policy_input.state is None:", "        return 'FAIL_CLOSED'", "    return 'OK'", "",
      callers,
    ].join("\n"));
    const evidence = await expandedForFirst(root);
    assert.match(evidence, /return_fanout=9 unresolved=fanout_exceeds_8/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("0.6.0 handles qualified policy.PolicyInput returned from a method with multiple callers", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-qualified-method-fanout-"));
  try {
    writeFileSync(join(root, "flow.py"), [
      "from dataclasses import dataclass", "", "@dataclass", "class PolicyInput:", "    allocation_state: object", "",
      "class policy:", "    PolicyInput = PolicyInput", "",
      "class Adapter:",
      "    def _allocation_state(self):", "        try:", "            return parse_state()", "        except ValueError:", "            return None", "",
      "    def _build_policy_input(self):", "        allocation_state = self._allocation_state()", "        return policy.PolicyInput(allocation_state=allocation_state)", "",
      "    def evaluate(self, policy_input):", "        if policy_input.allocation_state is None:", "            return 'FAIL_CLOSED'", "        return 'OK'", "",
      "    def run_a(self):", "        policy_input = self._build_policy_input()", "        return self.evaluate(policy_input)", "",
      "    def run_b(self):", "        policy_input = self._build_policy_input()", "        return self.evaluate(policy_input)", "",
    ].join("\n"));
    const evidence = await expandedForFirst(root);
    assert.match(evidence, /constructor=PolicyInput binding=allocation_state->PolicyInput\.allocation_state returned_by=_build_policy_input/);
    assert.match(evidence, /return_fanout=2 resolved=2 unresolved=0/);
    assert.match(evidence, /call=run_[ab]->evaluate binding=policy_input->policy_input/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
