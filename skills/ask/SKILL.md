---
name: ask
description: Use pi-semantic-screen presets/providers to cheaply screen many candidates, then review deterministic evidence with extension-owned exact state.
---

# Semantic screening workflow

Prefer the preset/provider path whenever the task matches an installed preset. Presets contain classifier and review policy; providers own deterministic discovery and evidence extraction. Do not reimplement provider logic in Code Mode, Python, PowerShell, grep, or ad-hoc AST code when registered tools can do it.

## Canonical preset flow

1. In one Code Mode execution call `screen_preset({id})` exactly once, then `screen_discover({preset:id, scope, mode:"count"})`, then `screen_preflight({count})`. Return only compact count/approval status. No candidate text or classifier calls are allowed before approval. If approval is required, stop and ask for explicit approval.
2. For the normal path, call `screen_primary_start({preset:id, scope, confirm})` exactly once after the guard is satisfied: use `confirm:true` only after explicit approval; if preflight returned `ok`, use `confirm:false`. **Do not call `screen_discover(... mode:"candidates")`, `screen_batch`, or `screen_review_start` yourself.** `screen_primary_start` performs candidate discovery internally, loads the exact preset-owned primary question/criteria/threshold inside the extension, computes retained IDs, and atomically starts review. The model must never copy, paraphrase, reconstruct, or override the preset primary contract.
3. Require `primary.status === "ok"` and `reviewStarted === true` before entering semantic review. If status is `approval_required` or `error`, stop with `reviewStarted:false`. Each `screen_primary_start` rediscovers candidates and creates a fresh primary snapshot. The extension reuses only unchanged per-candidate classifier outcomes in the active Pi process; `rescreen:true` explicitly bypasses that semantic cache.
4. Refinement is opt-in only. When `--refine` is explicitly requested, call `screen_primary_start({preset:id, scope, confirm, deferReview:true})`; this stores primary retained candidates inside extension-owned process state and does not start review. Then call `screen_refinement_start({primaryRunId, confirm:false})`. If it returns `approval_required`, ask for explicit refinement approval and retry once with `confirm:true`. The extension owns the exact preset refinement question/criteria/threshold and starts review from refinement-retained IDs. Report returned `refinementYield`; `lowYield:true` means do not add further classifier stages. Never serialize retained candidate text/IDs in Code Mode to run refinement manually.
5. If the user asks to audit or inspect primary outcomes (especially DROP safety), call read-only `screen_primary_manifest({primaryRunId, labels:[...]})`. It reads the completed extension-owned primary snapshot and must not be used to reconstruct or replace canonical review state. Treat its `reason` as a deterministic threshold/bucket explanation, not as model rationale.
6. After successful initialization, return only compact primary/refinement counts, `workflowId`, and review progress. Do not manually compute or pass `reviewTargetIds` in canonical preset workflows.

Nested Code Mode tool results may be JSON strings. When composition requires a nested structured result, normalize once with `typeof raw === "string" ? JSON.parse(raw) : raw`. Do not infer structure from a summary string.

## Extension-owned screening and review state

After `screen_primary_start` succeeds, the model must not maintain primary or semantic-review accounting. Do not store/copy the preset question, criteria, threshold, retained candidate IDs, `reviewedIds`, `evidenceSeenIds`, `needsExpandedEvidenceIds`, `blockedEvidenceIds`, `pendingPacketIds`, findings, offsets, or packet counters in Code Mode.

The extension owns these invariants:

- preset primary/refinement semantic contracts are loaded from the preset registry inside the extension;
- every primary initialization is a fresh deterministic discovery snapshot; classifier reuse is per-candidate only;
- primary retained IDs are `kept + undecided + withheld + errors` and are never reconstructed by the model;
- `reviewedIds ⊆ evidenceSeenIds`;
- standard `INSUFFICIENT_EVIDENCE` is queued for expanded evidence;
- expanded `INSUFFICIENT_EVIDENCE` is quarantined per ID without stopping independent targets;
- blocked IDs remain unreviewed;
- only `CONFIRM` creates findings;
- pending packet identity and exact disposition coverage are validated atomically;
- repeated `screen_review_next` before commit returns the same pending packet rather than advancing;
- terminal status is `complete` or `review_complete_with_blocked_evidence`.

Screening/review workflow state is process-local to the active Pi session. Context compaction does not lose it. Restarting the Pi process clears it.

## Semantic review loop

Use `screen_review_next` and `screen_review_commit` directly for semantic review; no Code Mode state machine is needed.

1. Call `screen_review_next({workflowId})`. On later `/screen-continue` turns the `workflowId` may be omitted to resume the latest active workflow in this Pi session.
2. If status is `packet`, read only that packet's emitted `reviewContract` and evidence. Apply the contract exactly. Produce exactly one `{id, disposition, rationale}` for every returned packet ID.
3. Call `screen_review_commit({workflowId, packetId, dispositions})` exactly once. Do not call `screen_review_apply`, do not hand-write coverage validation, and do not update review sets manually.
4. If commit returns `ready`, call `screen_review_next` for the next packet. If commit returns `complete` or `review_complete_with_blocked_evidence`, stop and report its compact final progress/findings/blocked summary.
5. Review at most three distinct packets or roughly 100-120 semantic dispositions in one user turn. If more work remains, return `resumeAvailable:true`; `/screen-continue` resumes through the latest extension-owned workflow with zero classifier, preflight, rediscovery, or model-owned state-merging calls.

`screen_review_next` is idempotent while a packet is pending. If a turn is interrupted after fetch but before commit, the next call returns the same packet and packet ID. A stale or duplicate commit fails closed and does not advance state.

A successful evidence packet may contain fewer IDs than the internal request because provider/token bounds trim only at whole-item boundaries. This is normal. The extension validates returned packet/item identity before making it pending; the model does not compare requested count to returned count.

## Review contract

Each packet carries the preset's explicit `reviewContract`. Treat it as authoritative rather than substituting generic intuition.

- `CONFIRM`: hidden/changed failure semantics with a material core outward effect.
- `EXPLICIT_FAILURE`: the failure is surfaced or fail-closed.
- `UI_ONLY`: rendering/formatting/display-only effect without feedback into core data, persisted state, validation, business/control flow, or execution.
- `OPTIONAL_ENRICHMENT`: best-effort enrichment whose absence cannot masquerade as a successful core result.
- `CLEANUP_RETRY_TELEMETRY`: cleanup, retry/reconnect, logging, telemetry.
- `EXPECTED_NORMALIZATION`: normalization explicitly allowed by the outward/source contract.
- `NO_OUTWARD_EFFECT`: evidence affirmatively establishes no core outward effect; missing context is not enough.
- `INSUFFICIENT_EVIDENCE`: evidence cannot establish confirmation or a terminal rejection.

For the Python-exceptions preset, if emitted evidence proves that a malformed authoritative record is skipped from a normally returned authoritative collection, `CONFIRM` applies unless that specific omission is positively shown to be permitted or surfaced. Do not require proof that no unshown reporting mechanism exists. Returning an empty/default domain object after an authoritative persisted-state read/parse failure likewise confirms unless that defaulting is explicitly permitted and surfaced.

## Low-level compatibility tools

`screen_batch`, `screen_evidence`, `screen_review_apply`, and `screen_review_start` remain available as low-level APIs for tests, ad-hoc integrations, and custom workflows. Canonical preset workflows use `screen_primary_start` / optional `screen_refinement_start`, then `screen_review_next` / `screen_review_commit` so semantic contracts, retained IDs, and mutable workflow state stay inside the extension.

## Ad-hoc `/screen`

For tasks without a preset, `screen_batch` remains available directly. The caller is responsible for stable, self-contained candidate text and semantic criteria. Do not claim preset-owned contract or deterministic review-state guarantees for an ad-hoc workflow.
