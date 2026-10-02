import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const skill = readFileSync(new URL("../skills/ask/SKILL.md", import.meta.url), "utf8");
const genericPrompt = readFileSync(new URL("../prompts/screen-use.md", import.meta.url), "utf8");
const exceptionPrompt = readFileSync(new URL("../prompts/screen-exceptions.md", import.meta.url), "utf8");
const continuePrompt = readFileSync(new URL("../prompts/screen-continue.md", import.meta.url), "utf8");
const adHocPrompt = readFileSync(new URL("../prompts/screen.md", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));


test("package exposes extensions, skills, and prompt templates", () => {
  assert.deepEqual(packageJson.pi.extensions, ["./extensions/screen.ts"]);
  assert.deepEqual(packageJson.pi.skills, ["./skills"]);
  assert.deepEqual(packageJson.pi.prompts, ["./prompts/*.md"]);
});

test("generic skill delegates deterministic work to preset adapters", () => {
  assert.match(skill, /Presets contain the semantic questions and review policy; adapters own deterministic discovery and evidence extraction/i);
  assert.match(skill, /Do not reimplement adapter logic in Code Mode, Python, PowerShell, grep, or ad-hoc AST code/i);
  assert.match(skill, /screen_preset\(\{id\}\)/i);
  assert.match(skill, /screen_discover\(\{preset:id, scope, mode:"count"\}\)/i);
  assert.match(skill, /screen_evidence/i);
});

test("generic skill keeps the approval guard before rich discovery", () => {
  assert.match(skill, /`screen_preflight\(\{count\}\)` before constructing candidate text/i);
  assert.match(skill, /No classifier calls are allowed before approval/i);
  assert.match(skill, /mode:"candidates"\}\)` once/i);
});

test("generic skill keeps primary canonical and refinement opt-in", () => {
  assert.match(skill, /first successful primary result is canonical/i);
  assert.match(skill, /Refinement is opt-in only/i);
  assert.match(skill, /A large retained set alone is not authorization/i);
  assert.match(skill, /refinementYield = refinementDropped \/ primaryRetained/i);
  assert.match(skill, /below 0\.30 mark `lowYield:true`/i);
});

test("review state preserves exact evidence accounting", () => {
  assert.match(skill, /semantic_screen_review_state/i);
  assert.match(skill, /`reviewedIds ⊆ evidenceSeenIds`/i);
  assert.match(skill, /exact previous `pendingPacketIds`/i);
  assert.match(skill, /resumeAvailable:false.*exactly equals the review-target set/is);
  assert.match(skill, /Never infer reviewed coverage from requested packet size, offsets, or slices/i);
});

test("review evidence comes only from screen_evidence", () => {
  assert.match(skill, /Fetch evidence only with `screen_evidence`/i);
  assert.match(skill, /do not regenerate source extractors in Code Mode/i);
  assert.match(skill, /exact `packetIds`/i);
  assert.match(skill, /about 120 semantic dispositions or two large evidence packets/i);
});

test("screen-use is the generic preset entry point", () => {
  assert.match(genericPrompt, /preset `\$1`, scope `\$\{2:-\.\}`/i);
  assert.match(genericPrompt, /Use only `screen_preset`, `screen_discover`, `screen_preflight`, `screen_batch`, and `screen_evidence`/i);
  assert.match(genericPrompt, /Do not recreate the preset's discovery\/evidence logic/i);
  assert.match(genericPrompt, /`--refine`/i);
});

test("screen-exceptions is a short alias rather than a workflow implementation", () => {
  assert.match(exceptionPrompt, /preset: `python-exceptions`/i);
  assert.match(exceptionPrompt, /alias for `\/screen-use python-exceptions/i);
  assert.match(exceptionPrompt, /Do not implement Python AST discovery or evidence extraction in Code Mode/i);
  assert.ok(exceptionPrompt.split(/\r?\n/).length < 20, "exception alias should stay compact");
  assert.doesNotMatch(exceptionPrompt, /ast\.ExceptHandler|PowerShell|btoa|TextEncoder|40,000|120 semantically reviewed/i);
});

test("screen-continue resumes only through the stored preset adapter", () => {
  assert.match(continuePrompt, /load `semantic_screen_review_state`/i);
  assert.match(continuePrompt, /Do not call `screen_preflight`, `screen_discover`, or `screen_batch`/i);
  assert.match(continuePrompt, /continue only through `screen_evidence`/i);
  assert.match(continuePrompt, /zero classifier calls and zero rediscovery passes/i);
  assert.match(continuePrompt, /exact `packetIds`/i);
});

test("ad-hoc screen clearly distinguishes weaker guarantees", () => {
  assert.match(adHocPrompt, /Prefer `\/screen-use <preset>/i);
  assert.match(adHocPrompt, /genuinely ad-hoc task/i);
  assert.match(adHocPrompt, /Do not claim deterministic semantic-review coverage/i);
});


test("preset orchestration forbids direct preview plus Code Mode duplicate calls", () => {
  assert.match(skill, /single-call-per-stage/i);
  assert.match(skill, /never make a direct preview call and then repeat the same `screen_preset`, `screen_discover`, `screen_preflight`, `screen_batch`, or `screen_evidence` call inside Code Mode/i);
  assert.match(skill, /one Code Mode execution, call `screen_preset\(\{id\}\)`, then `screen_discover\(\{preset:id, scope, mode:"count"\}\)`, then `screen_preflight\(\{count\}\)`/i);
  assert.match(skill, /call `screen_discover\(\{preset:id, scope, mode:"candidates"\}\)` once and immediately call `screen_batch` once/i);
  assert.match(genericPrompt, /one Code Mode call per structured stage/i);
  assert.match(genericPrompt, /never call a tool directly for a preview and then repeat the same call inside Code Mode/i);
});

test("evidence orchestration fetches each packet once and stores exact ids in the same execution", () => {
  assert.match(skill, /Fetch each evidence packet exactly once from Code Mode/i);
  assert.match(skill, /In the same Code Mode execution, set `pendingPacketIds` to those exact IDs/i);
  assert.match(genericPrompt, /Fetch each packet exactly once inside Code Mode/i);
  assert.match(genericPrompt, /Never do direct `screen_evidence` \+ Code Mode `screen_evidence` for the same packet/i);
  assert.match(continuePrompt, /Do not make direct preview calls to `screen_preset` or `screen_evidence` and then repeat them in Code Mode/i);
});
