import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function text(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("0.8 generic review core contains no exception-suppression vocabulary", () => {
  const source = text("../src/review-contract.ts");
  for (const token of ["UI_ONLY", "OPTIONAL_ENRICHMENT", "CLEANUP_RETRY_TELEMETRY", "EXPECTED_NORMALIZATION", "NO_OUTWARD_EFFECT"]) {
    assert.equal(source.includes(token), false, `generic review core contains ${token}`);
  }
});

test("0.8 generic-source traversal contains no language or package-ecosystem skip policy", () => {
  const source = text("../src/providers/generic-source.ts");
  for (const token of ["node_modules", ".venv", "__pycache__", "target", "vendor"]) {
    assert.equal(source.includes(token), false, `generic-source hard-codes ecosystem directory ${token}`);
  }
  assert.match(source, /skipDirs\?: string\[\]/);
  assert.match(source, /\.git/);
  assert.match(source, /\.hg/);
  assert.match(source, /\.svn/);
});

test("0.8 generic-source does not contain a hidden language parser or local-call graph", () => {
  const source = text("../src/providers/generic-source.ts");
  for (const token of ["local_callers", "localCallers", "arrow function", "typescript", "javascript", "python"]) {
    assert.equal(source.toLowerCase().includes(token.toLowerCase()), false, `generic-source contains language-specific structural logic: ${token}`);
  }
});

test("0.8 classifier selection has no built-in vendor or model preference", () => {
  const source = text("../extensions/screen.ts");
  assert.doesNotMatch(source, /DEFAULT_PROVIDER_MODEL|PROVIDER_ORDER|typesafe\/jev/i);
  assert.match(source, /return available\[0\]/);
  assert.match(source, /PI_SEMANTIC_SCREEN_CLASSIFIER must use provider\/model format/);
  assert.match(source, /from PI_SEMANTIC_SCREEN_CLASSIFIER is not available\/configured/);
});
