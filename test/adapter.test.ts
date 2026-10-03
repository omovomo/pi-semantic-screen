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
      "    if enabled():",
      "        try:",
      "            run()",
      "        except Exception:",
      "            pass",
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


test("python-exceptions evidence walks out of nested blocks and expanded detail adds function context", async () => {
  const { root, cleanup } = fixture();
  try {
    const scope = join(root, "pkg");
    const rich = await pythonExceptionsAdapter.discover({ scope, mode: "candidates" });
    assert.equal(rich.status, "ok");
    const id = rich.items!.find((item) => item.text.includes("scope: other"))!.id;

    const standard = await pythonExceptionsAdapter.evidence({
      scope,
      ids: [id],
      maxItems: 10,
      maxSources: 2,
      maxChars: 40_000,
      detail: "standard",
    });
    assert.equal(standard.status, "ok");
    assert.match(standard.items[0].evidence, /downstream: return 1/);
    assert.match(standard.items[0].evidence, /function_returns: return 1/);
    assert.doesNotMatch(standard.items[0].evidence, /expanded_function_tail:/);

    const expanded = await pythonExceptionsAdapter.evidence({
      scope,
      ids: [id],
      maxItems: 10,
      maxSources: 2,
      maxChars: 40_000,
      detail: "expanded",
    });
    assert.equal(expanded.status, "ok");
    assert.match(expanded.items[0].evidence, /expanded_function_tail:/);
    assert.match(expanded.items[0].evidence, /return 1/);
  } finally {
    cleanup();
  }
});


test("expanded python exception evidence includes targeted post-handler data-flow hints", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-dataflow-"));
  try {
    writeFileSync(
      join(root, "policy.py"),
      [
        "def evaluate():",
        "    rsi_data = {}",
        "    try:",
        "        rsi_data = load_rsi()",
        "    except Exception:",
        "        pass",
        "    snapshot = build_snapshot(rsi_data)",
        "    return snapshot",
        "",
      ].join("\n"),
    );
    const rich = await pythonExceptionsAdapter.discover({ scope: root, mode: "candidates" });
    assert.equal(rich.status, "ok");
    const id = rich.items![0].id;
    const expanded = await pythonExceptionsAdapter.evidence({
      scope: root,
      ids: [id],
      maxItems: 10,
      maxSources: 2,
      maxChars: 40_000,
      detail: "expanded",
    });
    assert.equal(expanded.status, "ok");
    assert.match(expanded.items[0].evidence, /dataflow: tracked=rsi_data/);
    assert.match(expanded.items[0].evidence, /pre_try_writes=.*rsi_data.*= \{\}/s);
    assert.match(expanded.items[0].evidence, /post_handler_reads=.*build_snapshot\(rsi_data\)/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expanded python exception evidence surfaces validation, core-call, persistence, and wider caller context", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-semantic-hints-"));
  try {
    writeFileSync(
      join(root, "policy.py"),
      [
        "def evaluate():",
        "    state = {}",
        "    try:",
        "        state = load_state()",
        "    except OSError:",
        "        pass",
        "    if not state:",
        "        mark_degraded(state)",
        "    save_state(state)",
        "    return publish(state)",
        "",
        "def caller():",
        "    result = evaluate()",
        "    if result:",
        "        return result",
        "    return None",
        "",
      ].join("\n"),
    );
    const rich = await pythonExceptionsAdapter.discover({ scope: root, mode: "candidates" });
    assert.equal(rich.status, "ok");
    const id = rich.items![0].id;
    const expanded = await pythonExceptionsAdapter.evidence({
      scope: root,
      ids: [id],
      maxItems: 10,
      maxSources: 2,
      maxChars: 40_000,
      detail: "expanded",
    });
    assert.equal(expanded.status, "ok");
    const evidence = expanded.items[0].evidence;
    assert.match(evidence, /semantic_hints:/);
    assert.match(evidence, /post_handler_controls=.*if not state/s);
    assert.match(evidence, /post_handler_calls=.*mark_degraded\(state\)/s);
    assert.match(evidence, /persistence_calls=.*save_state\(state\)/s);
    assert.match(evidence, /callers:.*result = evaluate\(\).*if result/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expanded interprocedural evidence follows a fallback return into one exact caller", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-return-flow-"));
  try {
    writeFileSync(
      join(root, "flow.py"),
      [
        "def inner():",
        "    try:",
        "        return load()",
        "    except Exception:",
        "        return None",
        "",
        "def evaluate(value):",
        "    return value",
        "",
        "def outer():",
        "    value = inner()",
        "    decision = evaluate(value)",
        "    return decision",
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
    assert.match(evidence, /interprocedural_flow:/);
    assert.match(evidence, /edge1=inner->outer binding=return->value/);
    assert.match(evidence, /evaluate\(value\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expanded interprocedural evidence maps tracked call arguments to exact callee parameters", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-arg-flow-"));
  try {
    writeFileSync(
      join(root, "flow.py"),
      [
        "def build_policy(policy_value):",
        "    return policy_value",
        "",
        "def run(raw):",
        "    try:",
        "        x = parse(raw)",
        "    except ValueError:",
        "        x = None",
        "    return build_policy(x)",
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
    assert.match(evidence, /edge1=run->build_policy binding=x->policy_value/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expanded interprocedural evidence emits at most two exact call edges", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-two-hop-"));
  try {
    writeFileSync(
      join(root, "flow.py"),
      [
        "def final_sink(value):",
        "    return value",
        "",
        "def stage2(value):",
        "    return final_sink(value)",
        "",
        "def stage1(value):",
        "    return stage2(value)",
        "",
        "def run():",
        "    try:",
        "        x = load()",
        "    except Exception:",
        "        x = None",
        "    return stage1(x)",
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
    assert.match(evidence, /edge1=run->stage1/);
    assert.match(evidence, /edge2=stage1->stage2/);
    assert.doesNotMatch(evidence, /edge3=/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expanded interprocedural evidence fails closed on ambiguous callee definitions", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-ambiguous-flow-"));
  try {
    writeFileSync(
      join(root, "a.py"),
      [
        "def consume(value):",
        "    return value",
        "",
        "def run():",
        "    try:",
        "        x = load()",
        "    except Exception:",
        "        x = None",
        "    return consume(x)",
        "",
      ].join("\n"),
    );
    writeFileSync(join(root, "b.py"), "def consume(value):\n    return value\n");
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
    assert.match(evidence, /terminal=unknown/);
    assert.match(evidence, /ambiguous\/unresolved callee consume: 2 definitions/);
    assert.doesNotMatch(evidence, /edge1=run->consume/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expanded interprocedural evidence tracks subscript mutation into a returned data container", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-subscript-flow-"));
  try {
    writeFileSync(
      join(root, "flow.py"),
      [
        "from dataclasses import dataclass",
        "",
        "@dataclass",
        "class LoadResult:",
        "    rsi_by_ticker: dict",
        "",
        "def fetch(ticker):",
        "    rsi_data = {}",
        "    try:",
        "        rsi_data[ticker] = compute_rsi(ticker)",
        "    except Exception:",
        "        pass",
        "    return LoadResult(rsi_by_ticker=rsi_data)",
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
    assert.match(evidence, /affected=rsi_data/);
    assert.match(evidence, /returned_container_binding=rsi_data->LoadResult\.rsi_by_ticker/);
    assert.match(evidence, /terminal=normal_return/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expanded interprocedural evidence models continue as current-iteration omission", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-continue-flow-"));
  try {
    writeFileSync(
      join(root, "flow.py"),
      [
        "def load_trades(rows):",
        "    raw_trades = []",
        "    for row in rows:",
        "        try:",
        "            quantity = float(row['quantity'])",
        "        except (TypeError, ValueError):",
        "            continue",
        "        raw_trades.append({'quantity': quantity})",
        "    return raw_trades",
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
    assert.match(evidence, /effect=.*control=continue/);
    assert.match(evidence, /terminal=iteration_omission/);
    assert.match(evidence, /skipped_mutations=raw_trades/);
    assert.match(evidence, /raw_trades\.append/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expanded interprocedural evidence offsets implicit self for bound method arguments", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-bound-method-"));
  try {
    writeFileSync(
      join(root, "flow.py"),
      [
        "class Worker:",
        "    def consume(self, value):",
        "        return value",
        "",
        "    def run(self, raw):",
        "        try:",
        "            x = parse(raw)",
        "        except ValueError:",
        "            x = None",
        "        return self.consume(x)",
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
    assert.match(evidence, /edge1=run->consume binding=x->value/);
    assert.doesNotMatch(evidence, /binding=x->self/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expanded interprocedural evidence skips incidental unresolved calls and reaches an exact second hop", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-second-hop-priority-"));
  try {
    writeFileSync(
      join(root, "flow.py"),
      [
        "def stage2(value):",
        "    return value",
        "",
        "def stage1(value):",
        "    debug_text = str(value)",
        "    return stage2(value)",
        "",
        "def run():",
        "    try:",
        "        x = load()",
        "    except Exception:",
        "        x = None",
        "    return stage1(x)",
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
    assert.match(evidence, /edge1=run->stage1/);
    assert.match(evidence, /edge2=stage1->stage2/);
    assert.doesNotMatch(evidence, /ambiguous\/unresolved second-hop callee str/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expanded interprocedural evidence surfaces break as loop termination", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-break-flow-"));
  try {
    writeFileSync(
      join(root, "flow.py"),
      [
        "def load_rows(rows):",
        "    result = []",
        "    for row in rows:",
        "        try:",
        "            value = parse(row)",
        "        except ValueError:",
        "            break",
        "        result.append(value)",
        "    return result",
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
    assert.match(expanded.items[0].evidence, /terminal=loop_termination/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expanded interprocedural evidence surfaces handler raise as explicit failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-raise-flow-"));
  try {
    writeFileSync(
      join(root, "flow.py"),
      [
        "def load_value():",
        "    try:",
        "        return load()",
        "    except OSError:",
        "        raise",
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
    assert.match(expanded.items[0].evidence, /terminal=explicit_failure/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expanded interprocedural evidence treats tracked mapping get as a local read and propagates through a constructed policy object", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-container-read-"));
  try {
    writeFileSync(
      join(root, "flow.py"),
      [
        "from dataclasses import dataclass",
        "",
        "class A:",
        "    def get(self, key):",
        "        return key",
        "",
        "class B:",
        "    def get(self, key):",
        "        return key",
        "",
        "@dataclass",
        "class PolicyInput:",
        "    rsi: object",
        "",
        "def evaluate(policy_input):",
        "    return policy_input",
        "",
        "def run(ticker):",
        "    rsi_data = {}",
        "    try:",
        "        rsi_data[ticker] = load_rsi(ticker)",
        "    except Exception:",
        "        pass",
        "    policy_input = PolicyInput(rsi=rsi_data.get(ticker))",
        "    return evaluate(policy_input)",
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
    assert.match(evidence, /constructor=PolicyInput binding=rsi_data\.get\(ticker\)->PolicyInput\.rsi result->policy_input/);
    assert.match(evidence, /edge1=run->evaluate binding=policy_input->policy_input/);
    assert.doesNotMatch(evidence, /ambiguous.*callee get/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expanded interprocedural evidence ranks persistence/core propagation above earlier logging", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-sink-ranking-"));
  try {
    writeFileSync(
      join(root, "flow.py"),
      [
        "def _log(value):",
        "    print(value)",
        "",
        "def _save_state(value):",
        "    return value",
        "",
        "def run():",
        "    try:",
        "        value = load()",
        "    except Exception:",
        "        value = None",
        "    _log(value)",
        "    return _save_state(value)",
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
    assert.match(evidence, /edge1=run->_save_state binding=value->value/);
    assert.doesNotMatch(evidence, /edge1=run->_log/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expanded interprocedural evidence keeps terminal unknown when a required returned second hop is ambiguous", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-ambiguous-return-"));
  try {
    writeFileSync(
      join(root, "flow.py"),
      [
        "class A:",
        "    def consume(self, value):",
        "        return value",
        "",
        "class B:",
        "    def consume(self, value):",
        "        return value",
        "",
        "def stage(value, worker):",
        "    return worker.consume(value)",
        "",
        "def run(worker):",
        "    try:",
        "        value = load()",
        "    except Exception:",
        "        value = None",
        "    return stage(value, worker)",
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
    assert.match(evidence, /edge1=run->stage/);
    assert.match(evidence, /terminal=unknown/);
    assert.match(evidence, /ambiguous second-hop callee consume: 2 definitions in required return/);
    assert.doesNotMatch(evidence, /terminal=normal_return evidence=ambiguous/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expanded evidence shows preserved pre-try sentinel and its fail-closed guard", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-sentinel-guard-"));
  try {
    writeFileSync(
      join(root, "flow.py"),
      [
        "def run():",
        "    evaluation = None",
        "    try:",
        "        evaluation = bridge()",
        "    except Exception:",
        "        record_observation('bridge failed')",
        "    if evaluation is None:",
        "        return fail_closed_snapshot()",
        "    return normal_snapshot(evaluation)",
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
    assert.match(evidence, /sentinel_handling:/);
    assert.match(evidence, /evaluation=None source=pre_try@2/);
    assert.match(evidence, /guard@7:if evaluation is None:/);
    assert.match(evidence, /return fail_closed_snapshot\(\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expanded evidence shows handler-assigned UNKNOWN sentinel and its explicit consumer", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-sentinel-handler-"));
  try {
    writeFileSync(
      join(root, "flow.py"),
      [
        "def run():",
        "    try:",
        "        state = classify()",
        "    except Exception:",
        "        state = 'UNKNOWN'",
        "    if state == 'UNKNOWN':",
        "        return unavailable()",
        "    return use_state(state)",
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
    assert.match(evidence, /state='UNKNOWN' source=handler@5/);
    assert.match(evidence, /guard@6:if state == 'UNKNOWN':/);
    assert.match(evidence, /return unavailable\(\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expanded policy terminal flow connects PolicyInput field to evaluator guard and outcome", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-policy-terminal-"));
  try {
    writeFileSync(
      join(root, "flow.py"),
      [
        "from dataclasses import dataclass",
        "",
        "@dataclass",
        "class PolicyInput:",
        "    allocation_state: object",
        "",
        "def evaluate_policy(policy_input):",
        "    if policy_input.allocation_state is None:",
        "        return DecisionSnapshot('FAIL_CLOSED')",
        "    return DecisionSnapshot('OK')",
        "",
        "def run():",
        "    try:",
        "        allocation_state = classify_allocation()",
        "    except Exception:",
        "        allocation_state = None",
        "    policy_input = PolicyInput(allocation_state=allocation_state)",
        "    return evaluate_policy(policy_input)",
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
    assert.match(evidence, /policy_terminal_flow:/);
    assert.match(evidence, /constructor=PolicyInput binding=allocation_state->PolicyInput\.allocation_state result->policy_input/);
    assert.match(evidence, /call=run->evaluate_policy binding=policy_input->policy_input/);
    assert.match(evidence, /if policy_input\.allocation_state is None:/);
    assert.match(evidence, /outcome=return@9:return DecisionSnapshot\('FAIL_CLOSED'\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expanded sentinel evidence uses the nearest preserved pre-try sentinel", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-sentinel-nearest-"));
  try {
    writeFileSync(
      join(root, "flow.py"),
      [
        "def run():",
        "    value = None",
        "    value = {}",
        "    try:",
        "        value = load()",
        "    except Exception:",
        "        pass",
        "    if not value:",
        "        return unavailable()",
        "    return value",
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
    assert.match(evidence, /value=\{\} source=pre_try@3/);
    assert.doesNotMatch(evidence, /value=None source=pre_try@2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expanded policy flow follows handler return None through caller binding into PolicyInput evaluator", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-return-policy-none-"));
  try {
    writeFileSync(
      join(root, "flow.py"),
      [
        "from dataclasses import dataclass",
        "",
        "@dataclass",
        "class PolicyInput:",
        "    allocation_state: object",
        "",
        "@dataclass",
        "class DecisionSnapshot:",
        "    availability: str",
        "",
        "def classify_allocation():",
        "    try:",
        "        return risky_classify()",
        "    except Exception:",
        "        return None",
        "",
        "def evaluate_policy(policy_input):",
        "    if policy_input.allocation_state is None:",
        "        return DecisionSnapshot('FAIL_CLOSED')",
        "    return DecisionSnapshot('OK')",
        "",
        "def run():",
        "    allocation_state = classify_allocation()",
        "    policy_input = PolicyInput(allocation_state=allocation_state)",
        "    return evaluate_policy(policy_input)",
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
    assert.match(evidence, /sentinel_handling:.*return=None source=handler@15/);
    assert.match(evidence, /caller_binding=return->allocation_state/);
    assert.match(evidence, /policy_terminal_flow:.*fallback_return=None/);
    assert.match(evidence, /constructor=PolicyInput binding=allocation_state->PolicyInput\.allocation_state result->policy_input/);
    assert.match(evidence, /call=run->evaluate_policy binding=policy_input->policy_input/);
    assert.match(evidence, /if policy_input\.allocation_state is None:/);
    assert.match(evidence, /outcome=return@19:return DecisionSnapshot\('FAIL_CLOSED'\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expanded policy flow follows handler return UNKNOWN through caller binding without name heuristics", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-return-policy-unknown-"));
  try {
    writeFileSync(
      join(root, "flow.py"),
      [
        "from dataclasses import dataclass",
        "",
        "class ValuationState:",
        "    UNKNOWN = 'UNKNOWN'",
        "",
        "@dataclass",
        "class PolicyInput:",
        "    valuation_state: object",
        "",
        "def classify_value():",
        "    try:",
        "        return parse_value()",
        "    except Exception:",
        "        return ValuationState.UNKNOWN",
        "",
        "def decide(x):",
        "    if x.valuation_state is ValuationState.UNKNOWN:",
        "        return 'UNAVAILABLE'",
        "    return 'OK'",
        "",
        "def run():",
        "    valuation_state = classify_value()",
        "    policy_input = PolicyInput(valuation_state=valuation_state)",
        "    return decide(policy_input)",
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
    assert.match(evidence, /fallback_return=ValuationState\.UNKNOWN/);
    assert.match(evidence, /constructor=PolicyInput binding=valuation_state->PolicyInput\.valuation_state result->policy_input/);
    assert.match(evidence, /call=run->decide binding=policy_input->x/);
    assert.match(evidence, /if x\.valuation_state is ValuationState\.UNKNOWN:/);
    assert.match(evidence, /outcome=return@18:return 'UNAVAILABLE'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expanded sentinel evidence does not mislabel a handler-mutated empty list as preserved sentinel", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-mutated-list-sentinel-"));
  try {
    writeFileSync(
      join(root, "flow.py"),
      [
        "def run(value):",
        "    coerced = []",
        "    try:",
        "        coerced.append(float(value))",
        "    except (TypeError, ValueError):",
        "        coerced.append(value)",
        "    return coerced",
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
    assert.match(evidence, /sentinel_handling: <none>/);
    assert.doesNotMatch(evidence, /coerced=\[\] source=pre_try/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expanded sentinel evidence does not claim empty mapping when try may have partially populated it", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-semantic-screen-partial-map-sentinel-"));
  try {
    writeFileSync(
      join(root, "flow.py"),
      [
        "def run(keys):",
        "    rates = {}",
        "    try:",
        "        for key in keys:",
        "            rates[key] = load_rate(key)",
        "    except OSError:",
        "        pass",
        "    return rates",
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
    assert.doesNotMatch(evidence, /rates=\{\} source=pre_try/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

