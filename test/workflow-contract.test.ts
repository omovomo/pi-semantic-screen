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
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontmatter, "SKILL.md must start with YAML frontmatter");
  assert.match(frontmatter[1], /^name:\s*\S+/m);
  assert.match(frontmatter[1], /^description:\s*\S+/m);
});

test("package exposes extensions, skills, and prompt templates", () => {
  assert.deepEqual(packageJson.pi.extensions, ["./extensions/screen.ts"]);
  assert.deepEqual(packageJson.pi.skills, ["./skills"]);
  assert.deepEqual(packageJson.pi.prompts, ["./prompts/*.md"]);
});

test("generic skill delegates discovery/evidence to presets and adapters", () => {
  assert.match(skill, /Presets contain classifier and review policy; adapters own deterministic discovery and evidence extraction/i);
  assert.match(skill, /Do not reimplement adapter logic in Code Mode, Python, PowerShell, grep, or ad-hoc AST code/i);
  assert.match(skill, /screen_preset\(\{id\}\)/i);
  assert.match(skill, /screen_discover\(\{preset:id, scope, mode:"count"\}\)/i);
});

test("generic skill keeps approval guard and canonical primary screening", () => {
  assert.match(skill, /screen_preflight\(\{count\}\)/i);
  assert.match(skill, /No candidate text or classifier calls are allowed before approval/i);
  assert.match(skill, /confirm:true/i);
  assert.match(skill, /omitting `confirm:true` is a workflow error/i);
  assert.match(skill, /primary\.status === "ok"/i);
  assert.match(skill, /do \*\*not\*\* call `screen_review_start`/i);
  assert.match(skill, /first successful primary result is canonical/i);
  assert.match(skill, /Refinement is opt-in only/i);
  assert.match(skill, /refinementYield = refinementDropped \/ primaryRetained/i);
  assert.match(skill, /below 0\.30 mark `lowYield:true`/i);
  assert.match(skill, /large retained set alone is not authorization/i);
});


test("post-approval canonical flow propagates approval with confirm true", () => {
  assert.match(skill, /screen_batch` once with the preset primary question\/criteria\/threshold \*\*and `confirm:true`\*\*/i);
  assert.match(genericPrompt, /Explicit approval must be propagated to the guarded classifier call through `confirm:true`/i);
});

test("non-ok primary result cannot start semantic review", () => {
  assert.match(skill, /require `primary\.status === "ok"` before constructing any review target/i);
  assert.match(skill, /If primary status is `approval_required` or `error`, stop with `reviewStarted:false`/i);
  assert.match(genericPrompt, /Require `primary\.status === "ok"` before computing retained IDs or starting review/i);
});

test("preset workflow hands review state ownership to the extension", () => {
  assert.match(skill, /screen_review_start\(\{preset, scope, reviewTargetIds\}\)/i);
  assert.match(skill, /extension now owns semantic-review state/i);
  assert.match(skill, /must not maintain semantic-review accounting/i);
  assert.match(skill, /Do not store or merge `reviewedIds`, `evidenceSeenIds`, `needsExpandedEvidenceIds`, `blockedEvidenceIds`, `pendingPacketIds`/i);
  assert.match(skill, /Review workflow state is process-local to the active Pi session/i);
  assert.doesNotMatch(skill, /semantic_screen_review_state/i);
});

test("semantic review loop uses next and atomic commit, not model-owned state merging", () => {
  assert.match(skill, /Use `screen_review_next` and `screen_review_commit` directly/i);
  assert.match(skill, /exactly one `\{id, disposition, rationale\}` for every returned packet ID/i);
  assert.match(skill, /Call `screen_review_commit\(\{workflowId, packetId, dispositions\}\)` exactly once/i);
  assert.match(skill, /Do not call `screen_review_apply`/i);
  assert.match(skill, /Repeated `screen_review_next` before commit returns the same pending packet/i);
  assert.match(skill, /at most three distinct packets or roughly 100-120 semantic dispositions/i);
});

test("review contract keeps explicit dispositions and persisted-state defaulting rule", () => {
  assert.match(skill, /`UI_ONLY`: rendering\/formatting\/display-only effect/i);
  assert.match(skill, /`EXPECTED_NORMALIZATION`: normalization explicitly allowed/i);
  assert.match(skill, /missing context is not enough/i);
  assert.match(skill, /returning an empty\/default domain object after an authoritative persisted-state read\/parse failure is not expected normalization/i);
});

test("screen-use initializes extension-owned review and avoids low-level review tools", () => {
  assert.match(genericPrompt, /preset `\$1`, scope `\$\{2:-\.\}`/i);
  assert.match(genericPrompt, /screen_batch` \*\*with `confirm:true`\*\*/i);
  assert.match(genericPrompt, /Require `primary\.status === "ok"`/i);
  assert.match(genericPrompt, /stop with `reviewStarted:false` and do not call `screen_review_start`/i);
  assert.match(genericPrompt, /screen_review_start/i);
  assert.match(genericPrompt, /nested tool result is a JSON string, parse it once/i);
  assert.match(genericPrompt, /Do not store semantic-review arrays\/sets/i);
  assert.match(genericPrompt, /screen_review_next.*screen_review_commit/is);
  assert.match(genericPrompt, /Do not use low-level `screen_evidence` or `screen_review_apply`/i);
  assert.match(genericPrompt, /`--refine`/i);
});

test("screen-exceptions stays a compact alias", () => {
  assert.match(exceptionPrompt, /preset: `python-exceptions`/i);
  assert.match(exceptionPrompt, /alias for `\/screen-use python-exceptions/i);
  assert.match(exceptionPrompt, /Do not implement Python AST discovery or evidence extraction in Code Mode/i);
  assert.ok(exceptionPrompt.split(/\r?\n/).length < 20, "exception alias should stay compact");
  assert.doesNotMatch(exceptionPrompt, /ast\.ExceptHandler|PowerShell|btoa|TextEncoder/i);
});

test("screen-continue resumes latest extension-owned workflow without rescreening", () => {
  assert.match(continuePrompt, /latest extension-owned semantic review/i);
  assert.match(continuePrompt, /Do not call `screen_preset`, `screen_preflight`, `screen_discover`, `screen_batch`, `screen_evidence`, or `screen_review_apply`/i);
  assert.match(continuePrompt, /screen_review_next\(\{\}\)/i);
  assert.match(continuePrompt, /screen_review_commit\(\{workflowId, packetId, dispositions\}\)/i);
  assert.match(continuePrompt, /Never maintain or merge those sets in Code Mode/i);
  assert.match(continuePrompt, /same pending packet and packet ID/i);
  assert.match(continuePrompt, /zero classifier calls and zero rediscovery passes/i);
});

test("ad-hoc screen clearly distinguishes weaker guarantees", () => {
  assert.match(adHocPrompt, /Prefer `\/screen-use <preset>/i);
  assert.match(adHocPrompt, /genuinely ad-hoc task/i);
  assert.match(adHocPrompt, /Do not claim deterministic semantic-review coverage/i);
});
