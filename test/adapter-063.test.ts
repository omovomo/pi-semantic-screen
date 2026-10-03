import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

test("0.6.3 Python adapter exposes generic structured-terminal evidence", () => {
  const source = readFileSync(join(root, "src/adapters/python-exceptions.py"), "utf8");
  assert.match(source, /structured_terminal_flow/);
  assert.doesNotMatch(source, /policy_terminal_flow/);
  assert.match(source, /CORE_FLOW_CALL_WORDS/);
  assert.doesNotMatch(source, /CORE_FLOW_CALL_WORDS[^\n]*\bpolicy\b/i);
  assert.doesNotMatch(source, /CORE_FLOW_CALL_WORDS[^\n]*\bdecision\b/i);
});

test("0.6.3 production adapter and current docs contain no audited-project vocabulary", () => {
  const paths = [
    "src/adapters/python-exceptions.py",
    "src/presets/python-exceptions.ts",
    "src/review-contract.ts",
    "README.md",
    "docs/adapters.md",
    "docs/architecture.md",
    "docs/testing.md",
  ];
  const forbidden = /\b(?:GARP|TradingView|Yahoo|TLH|rebalance|PolicyInput|RebalanceLoadResult|deterministic_adapter|allocation_state|holding_action|rsi|ticker)\b/i;
  for (const relative of paths) {
    const text = readFileSync(join(root, relative), "utf8");
    assert.doesNotMatch(text, forbidden, relative);
  }
});
