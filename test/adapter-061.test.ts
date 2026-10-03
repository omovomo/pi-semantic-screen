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

test("0.6.1 fan-out preserves exact consumer shapes even when the consumer guard is delegated", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-consumer-shapes-"));
  try {
    writeFileSync(join(root, "flow.py"), [
      "from dataclasses import dataclass", "", "@dataclass", "class PolicyInput:", "    allocation_state: object", "",
      "def classify_allocation():", "    try:", "        return risky()", "    except Exception:", "        return None", "",
      "def build_input():", "    allocation_state = classify_allocation()", "    return PolicyInput(allocation_state=allocation_state)", "",
      "def evaluate_final_policy(policy_input):", "    return project_decision(policy_input)", "",
      "def project_decision(policy_input):", "    return 'UNKNOWN'", "",
      "def run_a():", "    policy_input = build_input()", "    return evaluate_final_policy(policy_input)", "",
      "def run_b():", "    policy_input = build_input()", "    return evaluate_final_policy(policy_input)", "",
    ].join("\n"));
    const evidence = await expandedForFirst(root);
    assert.match(evidence, /return_fanout=2 resolved=2 unresolved=0/);
    assert.match(evidence, /consumer_shape=run_a->evaluate_final_policy/);
    assert.match(evidence, /consumer_shape=run_b->evaluate_final_policy/);
    assert.match(evidence, /terminal=<not proven>/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("0.6.1 resolves direct returned-object consumers used as evaluator arguments", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-direct-consumer-"));
  try {
    writeFileSync(join(root, "flow.py"), [
      "from dataclasses import dataclass", "", "@dataclass", "class PolicyInput:", "    state: object", "",
      "def parse_state():", "    try:", "        return risky()", "    except Exception:", "        return None", "",
      "def build_input():", "    state = parse_state()", "    return PolicyInput(state=state)", "",
      "def evaluate(policy_input):", "    if policy_input.state is None:", "        return 'FAIL_CLOSED'", "    return 'OK'", "",
      "def run_a():", "    return evaluate(build_input())", "",
      "def run_b():", "    return evaluate(build_input())", "",
    ].join("\n"));
    const evidence = await expandedForFirst(root);
    assert.match(evidence, /return_fanout=2 resolved=2 unresolved=0/);
    assert.match(evidence, /direct_consumer=run_a->evaluate binding=return->policy_input/);
    assert.match(evidence, /direct_consumer=run_b->evaluate binding=return->policy_input/);
    assert.match(evidence, /FAIL_CLOSED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("0.6.1 expanded evidence summarizes complete handler branch and exit topology", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-handler-flow-"));
  try {
    writeFileSync(join(root, "flow.py"), [
      "def process(value):",
      "    result = None",
      "    try:",
      "        result = risky(value)",
      "    except Exception:",
      "        if value == 'expected':",
      "            if value:",
      "                result = None",
      "            else:",
      "                raise ValueError('bad')",
      "        else:",
      "            return None",
      "    if result is None:",
      "        raise RuntimeError('fail closed')",
      "    return result",
    ].join("\n"));
    const evidence = await expandedForFirst(root);
    assert.match(evidence, /handler_control_flow: branches=2/);
    assert.match(evidence, /explicit_exits=.*raise@10.*return@12/);
    assert.match(evidence, /fallthrough=yes/);
    assert.match(evidence, /fallthrough_target=.*if result is None:/s);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
