# Changelog

## 0.5.3 - 2026-10-03

- Accept both object dispositions and compact `[id, disposition, rationale]` tuples in `screen_review_commit`; normalize them inside the extension-owned workflow before exact coverage validation, preventing a model-formatting retry without weakening fail-closed semantics.
- Compact the self-contained `python-exceptions` review contract while preserving authoritative-record/persisted-state, UI-only, normalization, and insufficient-evidence rules; the serialized contract is regression-bounded to 2700 bytes.
- Improve expanded Python evidence with targeted `post_handler_controls`, `post_handler_calls`, and `persistence_calls`, plus wider caller context, while keeping the same 7200-token packet budget.
- Add regressions for tuple commits, compact-contract size/semantics, and targeted validation/core-call/persistence/caller evidence.

## 0.5.2 - 2026-10-02

- Propagate explicit user approval into the guarded post-approval `screen_batch` call with mandatory `confirm:true`, so batches above the call limit actually invoke the classifier instead of returning all candidates as `withheld`.
- Fail closed before semantic review unless the canonical primary result has `status === "ok"`; `approval_required` and `error` results now require `reviewStarted:false` and must never reach `screen_review_start`.
- Add regression contract tests for both post-approval invariants.

## 0.5.1 - 2026-10-02

- Fix Pi skill metadata: `skills/ask/SKILL.md` now uses the required `description` frontmatter field instead of `summary`.
- Add a regression test that requires every shipped skill entry point to expose `name` and `description` metadata.

## 0.5.0 - 2026-10-02

- Move semantic-review state ownership from model-generated Code Mode bookkeeping into a process-local `ReviewWorkflowManager`.
- Add `screen_review_start`, `screen_review_next`, and `screen_review_commit` as the canonical preset review API.
- Make pending packet retrieval idempotent: repeated `screen_review_next` calls before commit return the same packet and do not rebuild evidence or advance queues.
- Make commit atomic and fail-closed for stale packet IDs and non-exact disposition coverage; the extension now owns reviewed/evidence-seen accounting, expanded priority, blocked quarantine, findings, and terminal status.
- Remove model-owned review arrays/sets from `/screen-use` and `/screen-continue`; continuation can resume the latest active workflow with zero classifier/rediscovery calls and no Code Mode state merging.
- Keep `screen_evidence` / `screen_review_apply` as low-level compatibility APIs rather than the canonical preset workflow.
- Clarify Python exception policy: failed authoritative persisted-state read/parse followed by a normal empty/default domain object is a finding unless that defaulting is explicitly permitted and surfaced.
- Document process-local review-state lifetime: context compaction is safe, Pi process restart requires a fresh screen.

## 0.4.0 - 2026-10-02

- Add generic `screen_review_apply` to validate exact disposition coverage and return deterministic review-state deltas, removing disposition branching/coverage bookkeeping from model-generated Code Mode logic.
- Treat bounded `screen_evidence` subsets as normal: expose `trimmed` and `trimReason`; `requested > packetIds.length` no longer triggers a retry when the returned packet itself is intact and within budget.
- Narrow `EXPECTED_NORMALIZATION`: silently skipping malformed authoritative source records is not normalization unless omission is explicitly permitted by the source contract and surfaced.
- Add targeted expanded Python data-flow evidence (`tracked`, `pre_try_writes`, `post_handler_reads`) to connect caught failures/fallback values to later function use.
- Preserve per-ID blocked-evidence quarantine, 7200-token transport budget, single classifier pass, and host-managed context compaction.

## 0.3.1 - 2026-10-02

- Quarantine expanded `INSUFFICIENT_EVIDENCE` per ID in `blockedEvidenceIds` instead of globally stopping semantic review.
- Continue reviewing independent targets after blocked evidence while keeping blocked IDs evidence-seen but explicitly unreviewed.
- Add exact queue semantics: expanded-needed first, then stable standard targets excluding reviewed and blocked IDs.
- Add `review_complete_with_blocked_evidence` terminal status when no actionable targets remain but blocked IDs still exist.
- Make `resumeAvailable` represent actionable resumable work rather than requiring every review target to be terminally reviewed.
- Persist only compact blocked IDs/reasons; blocked IDs cannot become findings without an explicit fresh/manual review.

## 0.3.0 - 2026-10-02

- Add an explicit `reviewContract` to every `screen_evidence` payload so semantic review receives the preset's instructions, confirmation rule, rejection rule, and fixed disposition vocabulary.
- Require exactly one `{id, disposition, rationale}` per pending evidence item before commit; only `CONFIRM` creates a finding.
- Add terminal non-finding dispositions for UI-only effects, optional enrichment, cleanup/retry/telemetry, expected normalization, explicit failure, and no demonstrated outward effect.
- Make `INSUFFICIENT_EVIDENCE` non-terminal: it does not advance `reviewedIds` and is refetched first with `detail:"expanded"`; unresolved expanded evidence stops fail-closed with `blockedOnEvidence`.
- Add `detail:"standard" | "expanded"` to `screen_evidence`; expanded Python exception evidence includes bounded function-tail context and additional caller hints.
- Improve Python exception continuation evidence by walking out of exhausted nested blocks and including containing-function return statements.
- Include the review contract itself in transport token-budget estimation.
- Enforce an explicit at-most-three evidence-packet continuation budget.

## 0.2.2 - 2026-10-02

- Bound `screen_evidence` by estimated serialized token cost (`maxTokens`, default 7200) before Code Mode transport; item/source/character limits remain secondary safety caps.
- Trim evidence only at whole-item boundaries and recompute exact `packetIds`, `sourceCount`, and `chars` after token bounding.
- Fail closed when a single evidence item cannot fit the token budget.
- Make fetched IDs pending only; `evidenceSeenIds`/`reviewedIds` advance only after the parent receives the complete packet and semantically dispositions it.
- Treat transport truncation or packet/item-ID mismatch as non-reviewable and retry with a lower token budget.
- Pipeline up to three distinct evidence packets per `/screen-continue` turn while keeping each packet single-fetch.
- Remove `screen_preset` from continuation; preset config is stored once and reused.
- Reduce redundant Python exception review evidence by replacing repeated enclosing-function bodies with compact function context/signature.
- Add `package-lock.json` and switch GitHub Actions to `npm ci`.


## 0.2.1 - 2026-10-02

### Changed

- Preset orchestration is now explicitly single-call-per-stage. Structured tools are called from Code Mode the first time their results are needed for state/composition; direct preview + Code Mode duplicate calls are prohibited.
- Initial preset/count/preflight work is grouped into one Code Mode stage.
- Candidate discovery + primary `screen_batch` are grouped into one post-approval Code Mode stage.
- Each `screen_evidence` packet is fetched exactly once; its exact `packetIds` are persisted in the same execution before evidence is emitted for parent review.
- `/screen-continue` follows the same no-preview/no-duplicate contract.

All notable changes to `pi-semantic-screen` are documented here.

## 0.2.0 - 2026-10-02

### Added

- Adapter/preset architecture for reusable semantic-screen workflows.
- Generic `screen_preset`, `screen_discover`, and `screen_evidence` tools.
- Built-in `python-exceptions` adapter with deterministic Python AST discovery and bounded evidence extraction.
- Generic `/screen-use <preset> [scope] [--refine]` prompt.
- Adapter/preset registry tests and Python adapter integration tests.
- Git-ready repository metadata, CI workflow, contribution/security docs, and architecture documentation.

### Changed

- `/screen-exceptions` is now a short alias for the `python-exceptions` preset instead of a Python-specific orchestration prompt.
- Source parsing/evidence extraction no longer needs model-generated Python/PowerShell in Code Mode.
- `/screen-continue` resumes through the registered adapter with zero rediscovery and zero classifier calls.
- Package documentation now separates generic engine, adapters, presets, prompts, and review state.

### Preserved

- `screen_batch` fail-closed accounting and in-process deduplication.
- `screen_preflight` zero-call approval guard.
- Optional classifier usage aggregation.
- Refinement remains opt-in.
- Context compaction defaults to host/Pi/Magic Context behavior.

## 0.1.10 - 2026-10-02

- Added classifier usage aggregation when the runtime reports complete usage.
- Added framed subprocess payload guidance.
- Changed extension compaction default to defer to the host.

## 0.1.8 - 2026-10-02

- Bound semantic review accounting to exact emitted evidence packet IDs.

## 0.1.7 - 2026-10-02

- Increased semantic-review packet granularity and reduced continuation round trips.

## 0.1.4 - 0.1.6

- Added `screen_preflight`, resumable review, deterministic approval boundaries, and review continuation safeguards.

## 0.1.0 - 0.1.3

- Initial native classifier batch tool, fail-closed accounting, redaction, bounded concurrency, and process-local result reuse.
