# Changelog

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
