import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const skill = readFileSync(new URL("../skills/ask/SKILL.md", import.meta.url), "utf8");
const genericPrompt = readFileSync(new URL("../prompts/screen-use.md", import.meta.url), "utf8");
const exceptionPrompt = readFileSync(new URL("../prompts/screen-exceptions.md", import.meta.url), "utf8");
const continuePrompt = readFileSync(new URL("../prompts/screen-continue.md", import.meta.url), "utf8");
const adHocPrompt = readFileSync(new URL("../prompts/screen.md", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("skill frontmatter includes Pi-required name and description", () => {
  assert.match(skill, /^---\s+[\s\S]*?name:\s*ask\s+[\s\S]*?description:/m);
});

test("package exposes extensions, skills, and prompt templates", () => {
  assert.ok(packageJson.pi?.extensions?.length > 0);
  assert.ok(packageJson.pi?.skills?.length > 0);
  assert.ok(packageJson.pi?.prompts?.length > 0);
});

test("generic skill delegates discovery/evidence to presets and providers", () => {
  assert.match(skill, /Presets contain classifier and review policy; providers own deterministic discovery and evidence extraction/i);
  assert.match(skill, /Do not reimplement provider logic in Code Mode, Python, PowerShell, grep, or ad-hoc AST code/i);
  assert.match(skill, /screen_preset\(\{id\}\)/i);
  assert.match(skill, /screen_discover\(\{preset:id, scope, mode:"count"\}\)/i);
});

test("canonical primary semantics are extension-owned after preflight", () => {
  assert.match(skill, /screen_preflight\(\{count\}\)/i);
  assert.match(skill, /No candidate text or classifier calls are allowed before approval/i);
  assert.match(skill, /screen_primary_start\(\{preset:id, scope, confirm\}\)/i);
  assert.match(skill, /Do not call `screen_discover\(\.\.\. mode:"candidates"\)`, `screen_batch`, or `screen_review_start` yourself/i);
  assert.match(skill, /exact preset-owned primary question\/criteria\/threshold inside the extension/i);
  assert.match(skill, /must never copy, paraphrase, reconstruct, or override the preset primary contract/i);
  assert.match(skill, /primary\.status === "ok"/i);
  assert.match(skill, /reviewStarted === true/i);
});

test("canonical primary rediscovers source while retained ids and semantic cache remain extension-owned", () => {
  assert.match(skill, /Each `screen_primary_start` rediscovers candidates/i);
  assert.match(skill, /reuses only unchanged per-candidate classifier outcomes/i);
  assert.match(skill, /`rescreen:true` explicitly bypasses that semantic cache/i);
  assert.match(skill, /primary retained IDs are `kept \+ undecided \+ withheld \+ errors`/i);
  assert.match(skill, /never reconstructed by the model/i);
  assert.match(skill, /Do not manually compute or pass `reviewTargetIds`/i);
});

test("optional refinement is also preset-owned and approval guarded", () => {
  assert.match(skill, /Refinement is opt-in only/i);
  assert.match(skill, /deferReview:true/i);
  assert.match(skill, /screen_refinement_start\(\{primaryRunId, confirm:false\}\)/i);
  assert.match(skill, /retry once with `confirm:true`/i);
  assert.match(skill, /exact preset refinement question\/criteria\/threshold/i);
  assert.match(skill, /refinementYield/i);
  assert.match(skill, /lowYield:true/i);
});

test("preset workflow hands review state ownership to the extension", () => {
  assert.match(skill, /must not maintain primary or semantic-review accounting/i);
  assert.match(skill, /Do not store\/copy the preset question, criteria, threshold, retained candidate IDs/i);
  assert.match(skill, /Do not store\/copy[\s\S]*`reviewedIds`[\s\S]*`pendingPacketIds`/i);
  assert.match(skill, /Screening\/review workflow state is process-local/i);
  assert.doesNotMatch(skill, /semantic_screen_review_state/i);
});

test("semantic review loop uses next and atomic commit, not model-owned state merging", () => {
  assert.match(skill, /Use `screen_review_next` and `screen_review_commit` directly/i);
  assert.match(skill, /exactly one `\{id, disposition, rationale\}` for every returned packet ID/i);
  assert.match(skill, /screen_review_commit\(\{workflowId, packetId, dispositions\}\)/i);
  assert.match(skill, /Do not call `screen_review_apply`/i);
  assert.match(skill, /Repeated `screen_review_next` before commit returns the same pending packet/i);
  assert.match(skill, /at most three distinct packets or roughly 100-120 semantic dispositions/i);
});

test("generic skill treats the current preset review contract as authoritative", () => {
  assert.match(skill, /Each evidence packet carries the exact preset-owned `reviewContract`/i);
  assert.match(skill, /Compact presets use the neutral `CONFIRM` \/ `REJECT` \/ `INSUFFICIENT_EVIDENCE` contract/i);
  assert.match(skill, /Advanced presets may define additional terminal dispositions/i);
  assert.doesNotMatch(skill, /malformed authoritative record is skipped from a normally returned authoritative collection/i);
  assert.doesNotMatch(skill, /empty\/default domain object after an authoritative persisted-state read\/parse failure/i);
});

test("screen-use uses extension-owned primary/refinement initialization", () => {
  assert.match(genericPrompt, /screen_primary_start/i);
  assert.match(genericPrompt, /Do not call candidate-mode `screen_discover`, `screen_batch`, or `screen_review_start`/i);
  assert.match(genericPrompt, /owns exact preset question\/criteria\/threshold, retained IDs, and review initialization/i);
  assert.match(genericPrompt, /screen_refinement_start/i);
  assert.match(genericPrompt, /deferReview:true/i);
  assert.match(genericPrompt, /screen_review_next.*screen_review_commit/is);
});

test("screen-exceptions stays a compact alias", () => {
  assert.match(exceptionPrompt, /preset: `python-exceptions`/i);
  assert.match(exceptionPrompt, /alias for `\/screen-use python-exceptions/i);
  assert.match(exceptionPrompt, /Do not implement Python AST discovery or evidence extraction in Code Mode/i);
  assert.ok(exceptionPrompt.split(/\r?\n/).length < 20, "exception alias should stay compact");
});

test("screen-continue resumes latest extension-owned workflow without any screening calls", () => {
  assert.match(continuePrompt, /latest extension-owned semantic review/i);
  assert.match(continuePrompt, /screen_primary_start/);
  assert.match(continuePrompt, /screen_refinement_start/);
  assert.match(continuePrompt, /screen_review_next\(\{\}\)/i);
  assert.match(continuePrompt, /screen_review_commit\(\{workflowId, packetId, dispositions\}\)/i);
  assert.match(continuePrompt, /same pending packet and packet ID/i);
  assert.match(continuePrompt, /zero classifier calls and zero rediscovery passes/i);
});

test("ad-hoc screen clearly distinguishes weaker guarantees", () => {
  assert.match(adHocPrompt, /Prefer `\/screen-use <preset>/i);
  assert.match(adHocPrompt, /genuinely ad-hoc task/i);
  assert.match(adHocPrompt, /Do not claim deterministic semantic-review coverage/i);
});
