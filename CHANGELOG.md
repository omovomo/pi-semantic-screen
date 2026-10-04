# Changelog

## 0.7.1 - 2026-10-04

- Make canonical primary runs rediscover candidates on every `screen_primary_start`; workflow-level reuse can no longer hide source edits.
- Keep classification reuse per candidate inside the active Pi process: unchanged candidates hit cache, changed/new candidates are recomputed, and removed candidates disappear with the new discovery snapshot.
- Clarify `rescreen:true` as an explicit classifier-cache bypass rather than the mechanism required to notice source changes.
- Add compact declarative presets using `source + question`; normalize them deterministically into the existing full `ScreeningPreset` with engine-owned classifier/review/budget defaults.
- Preserve the 0.7.0 advanced declarative JSON form unchanged as an escape hatch for explicit provider windows, refinement, and semantic contract overrides.
- Convert shipped `js-ts-silent-fallbacks` to the compact form; no JS-specific extension code is introduced.
- Keep classifier cache process-local; persistence across Pi sessions remains intentionally out of scope.
- Keep `python-exceptions` feature-frozen.

## 0.7.0 - 2026-10-04

- Re-center the package as a classifier-first semantic screening engine: canonical primary results now expose first-class reduction, review-avoidance, classifier-work, and cache metrics.
- Add versioned `EvidenceProvider` API v1 and route `python-exceptions` through the same provider boundary; historical adapter exports remain compatibility aliases.
- Validate provider registration against runtime API-version/identity/capability requirements, leaving external module loading as a separate future trust/packaging layer.
- Add declarative JSON preset loading from explicit paths, project `.pi-semantic-screen/presets`, `PI_SEMANTIC_SCREEN_PRESET_DIR`, and shipped presets.
- Add bounded `generic-source` provider (globs + regex discovery + candidate/standard/expanded source windows) and ship `js-ts-silent-fallbacks` as a second meaningful use case requiring no extension-code semantics.
- Keep declarative discovery fail-closed under bounds: an included source above `maxFileBytes` is an explicit provider error, never a silent omission.
- Add per-candidate classification cache keyed by semantic classifier contract, normalized candidate fingerprint, and resolved classifier model/implementation identity. Changed candidates are recomputed independently; contract/model changes invalidate fail-closed.
- Keep review dispositions uncached until reviewer identity/context can be represented safely; standard and expanded review remain explicitly separate future cache domains.
- Add review efficiency accounting for standard reviewed/resolved and expanded attempted/resolved/blocked, including expansion and expanded-resolution rates.
- Publish classifier token/cost efficiency fields only when usage accounting is complete for every executed classifier call; partial accounting remains explicitly incomplete.
- Add generic semantic-manifest stability comparison (`src/stability.ts`).
- Keep `python-exceptions` feature-frozen; no audited-application semantic rules were added.
- Preserve extension-owned primary/refinement contracts, retained IDs, review state machine, token budgets, blocked quarantine, and exact commit semantics.

## 0.6.3

- Freeze the built-in `python-exceptions` adapter after a de-specialization pass; no new evidence capability is added.
- Rename `policy_terminal_flow` to `structured_terminal_flow` and corresponding internal helpers to describe the structural behavior rather than one application domain.
- Remove project/domain vocabulary from Python call ranking (`policy`, `decision`) and use generic processing/persistence verbs instead.
- Remove finance-specific wording from the Python preset and GARP-specific paths/cases from package documentation; synthetic tests now use generic structured-result fixtures.
- Preserve extension-owned primary/review workflow, fail-closed ambiguity handling, bounded fan-out, handler control-flow, and packet budgets unchanged.

## 0.6.2 - 2026-10-03

- Fix expanded Python evidence for exception handlers outside functions: `handler_control_flow` is now initialized for every expanded candidate and no longer raises `UnboundLocalError` when `function_node` is absent.
- Add regression coverage for module-level exception handlers and preserve the 0.6.1 fan-out/whole-handler evidence behavior unchanged.

## 0.6.1 - 2026-10-03

- Improve bounded returned-object fan-out evidence: small exact caller sets now preserve exact consumer shapes even when the immediate consumer delegates its guard/decision logic, rather than collapsing those sites to unresolved.
- Resolve returned objects consumed directly as exact call arguments (for example `evaluate(build_input())`) without inventing an intermediate variable; wrapped/transformed calls remain unresolved.
- Add compact `handler_control_flow` to expanded Python exception evidence, summarizing branch count/tests, explicit `return`/`raise`/`continue`/`break` exits, whether the handler can fall through, and the single downstream fallthrough target.
- Keep canonical `screen_primary_start` ownership, review state machine, authoritative-record contract, generic two-call-edge bound, and 7200-token packet budget unchanged.
- Add regressions for delegated consumer fan-out, direct returned-object consumers, and multi-branch handler exit topology.

## 0.6.0 - 2026-10-03

- Move canonical preset primary semantics out of model-generated orchestration: add `screen_primary_start`, which performs candidate discovery internally, loads the exact preset primary question/criteria/threshold inside the extension, computes retained IDs, and starts review atomically.
- Add process-local `PresetScreeningWorkflowManager`: the first successful `preset+scope` primary initialization is canonical until explicit `rescreen:true`; repeated calls reuse the same initialization without rediscovery/classifier calls. Approval-required/error runs never become canonical state, and screening/result-cache state resets on `session_start`.
- Add extension-owned optional refinement with `screen_refinement_start`: `deferReview:true` stores primary retained candidates behind an opaque `primaryRunId`; refinement applies the exact preset refinement contract with its own call guard and starts review from refined retained IDs.
- Keep `screen_batch` and `screen_review_start` as low-level/ad-hoc compatibility APIs; canonical preset prompts no longer pass candidate arrays, semantic contracts, or `reviewTargetIds` through model context.
- Strengthen Python authoritative-record semantics: once evidence proves a malformed authoritative record is skipped from a normally returned authoritative collection, review should confirm unless that exact omission is positively shown permitted/surfaced; absence of separate reporting evidence alone is not insufficiency.
- Add bounded returned-object fan-out evidence for small exact caller sets. `structured_terminal_flow` reports `resolved/unresolved` consumer counts instead of arbitrarily selecting one caller; fan-out above eight sites remains explicitly unresolved.
- Preserve review dispositions, review state machine, blocked quarantine, the generic two-call-edge bound, and the 7200-token packet budget.
- Add regressions for extension-owned primary/refinement contracts, canonical initialization reuse, guarded refinement, returned structured-object fan-out, partial fan-out accounting, inline constructor fan-out, and large-fan-out bounding.

## 0.5.9 - 2026-10-03

- Follow exact fallback-return bindings through constructors returned directly from builder functions, then resume bounded tracing from the builder result in its immediate caller.
- Bind inline helper fallbacks used directly as constructor keyword values (for example `ResultEnvelope(field=helper())`) without inventing an intermediate local variable; only exact direct keyword values qualify.
- Add one terminal-result continuation after an already-proven evaluator guard outcome so a concrete returned state can be connected to its immediate caller-visible return/container sink without adding a third generic call edge.
- Tighten `structured_terminal_flow`: an exact project constructor-field binding is now required before a downstream guard/outcome is accepted as structured-terminal evidence, reducing incidental snapshot/policy branch matches.
- Keep state ownership, primary threshold, disposition vocabulary, two generic call-edge bound, blocked quarantine, and 7200-token transport budget unchanged.
- Add regressions for direct-return constructors, inline constructor helpers, and evaluator-result propagation into a returned snapshot.

## 0.5.8 - 2026-10-03

- Treat direct handler `return None` / `return UNKNOWN`-style fallbacks as synthetic affected values in expanded evidence and, when there is exactly one function definition and one caller site, surface the exact `return -> caller variable` binding.
- Continue those exact fallback-return bindings through project data/policy constructors and into exact callee guards with explicit bounded `return`/`raise`/state outcomes; remove policy/snapshot name matching as a prerequisite so evidence is structural rather than keyword-driven.
- Tighten `sentinel_handling`: do not report a pre-try empty list/mapping/set as the resulting sentinel when the handler mutates that container or the try body may have partially populated it before failure.
- Reject structural branch matches as `structured_terminal_flow` unless the exact bound parameter reaches a guard/validation with an explicit bounded outcome, reducing snapshot/fingerprint false positives.
- Keep review state, primary threshold, disposition vocabulary, two-edge bound, blocked quarantine, and 7200-token packet budget unchanged.
- Add regressions for `return None -> caller -> structured result -> consumer`, `return UNKNOWN`, handler-mutated empty lists, partially populated mappings, and false-positive structural branches.

## 0.5.7 - 2026-10-03

- Add `sentinel_handling` to expanded Python evidence: detect structurally obvious handler/pre-try `None`, `UNKNOWN`/missing-style strings, empty containers, and NaN-style sentinels, then show their first bounded guard and outward consumer without inferring safety.
- Add `structured_terminal_flow`: connect exact affected-value constructor bindings to downstream consumer calls, surface the first exact callee guard/validation over the bound parameter, and include a bounded explicit branch outcome.
- Preserve fail-closed semantics: handler-assigned sentinels outrank preserved pre-try values, the nearest prior sentinel is used, ambiguous bindings remain unresolved, and the new evidence never assigns review dispositions.
- Keep the 0.5.x review state machine, primary threshold, disposition vocabulary, two-call-edge interprocedural bound, and 7200-token packet budget unchanged.
- Add regressions for preserved pre-try fail-closed sentinels, handler-assigned `UNKNOWN`, policy-input-to-evaluator terminal guards, and nearest-sentinel selection.

## 0.5.6 - 2026-10-03

- Treat tracked `mapping.get(...)`/common container accessors as local reads rather than interprocedural call edges, preventing project-local `get` methods from creating false ambiguity.
- Propagate exact tracked keyword values through project data/policy constructors into the assigned result variable, then continue bounded tracing from that constructed object without consuming a call edge.
- Rank persistence/policy/core propagation above logging/render/display calls when selecting exact tracked call edges; ranking changes evidence selection only and never decides a review disposition.
- Keep ambiguous required returned hops fail-closed with `terminal=unknown`, and prevent ambiguous evidence from being paired with a contradictory normal-return terminal.
- Strengthen `UI_ONLY`: rendering/formatting/table/chart/detail output remains UI-only unless evidence shows feedback into core data, persisted state, policy, screening, or execution.
- Add regressions for mapping-accessor ambiguity, constructor-to-policy propagation, semantic sink ranking past logging, and ambiguous returned second hops.

## 0.5.5 - 2026-10-03

- Track subscript assignments such as `mapping[key] = value` as mutations of the base container, so omission/fallback flows can follow the outward collection identity.
- Model handler control transfer explicitly: `continue` now records a bounded current-iteration omission and the skipped collection mutations instead of pretending the loop tail executes; `break`/`raise` are surfaced as loop termination / explicit failure.
- Fix exact positional binding for bound instance/class methods so `obj.method(x)` maps `x` to the parameter after `self`/`cls`, while explicit `Class.method(obj, x)` remains unshifted.
- Prefer resolvable tracked-value calls over incidental unresolved calls when selecting interprocedural propagation, allowing real second-hop evidence without increasing the two-edge bound.
- Recognize exact tracked keyword bindings into returned project data containers and emit them as caller-visible return evidence.
- Reduce noisy affected-value sets by retaining try/handler assignments that are actually read after the handler, while preserving direct handler assignments.
- Add regressions for subscript mutation/returned-container flow, `continue` omission, bound-method binding, and second-hop selection past incidental unresolved calls.

## 0.5.4 - 2026-10-03

- Add value-directed interprocedural tracing to expanded `python-exceptions` evidence while leaving the review state machine, primary threshold, review contract, and 7200-token transport budget unchanged.
- Trace exact tracked-value bindings through local calls or one caller boundary, with a hard maximum of two call edges and bounded snippets.
- Fail closed on ambiguous/unresolved function bindings with `terminal=unknown`; no callee semantics are guessed from names.
- Surface a compact `interprocedural_flow` section alongside existing local data-flow/semantic hints, including exact origin, bindings, bounded edges, and terminal evidence.
- Add adapter regressions for fallback-return propagation, argument binding, two-hop bounding, and ambiguous-callee handling.

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
