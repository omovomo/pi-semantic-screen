---
name: ask
description: Use pi-semantic-screen presets/adapters to cheaply screen many candidates, then review deterministic evidence with extension-owned exact state.
---

# Semantic screening workflow

Prefer the preset/adapter path whenever the task matches an installed preset. Presets contain classifier and review policy; adapters own deterministic discovery and evidence extraction. Do not reimplement adapter logic in Code Mode, Python, PowerShell, grep, or ad-hoc AST code when registered tools can do it.

## Canonical preset flow

1. In one Code Mode execution call `screen_preset({id})` exactly once, then `screen_discover({preset:id, scope, mode:"count"})`, then `screen_preflight({count})`. Return only compact count/approval status. If approval is required, stop. No candidate text or classifier calls are allowed before approval.
2. After approval, in one Code Mode execution call `screen_discover({preset:id, scope, mode:"candidates"})` once and immediately call the canonical `screen_batch` once with the preset primary question/criteria/threshold **and `confirm:true`**. Explicit user approval authorizes this guarded batch; omitting `confirm:true` is a workflow error because the >200 guard will return `approval_required` again instead of running the classifier. Keep rich candidate text inside that execution.
3. Normalize the nested `screen_batch` result and require `primary.status === "ok"` before constructing any review target. If primary status is `approval_required` or `error`, stop with `reviewStarted:false` and do **not** call `screen_review_start`. For a successful primary, retained IDs are `kept + undecided + withheld + errors` after normalizing object buckets to `entry.id`. The first successful primary result is canonical; do not repeat it unless the user explicitly requests `rescreen:true`.
4. Refinement is opt-in only. If explicitly requested and the preset defines refinement, preflight it separately, run exactly one refinement classifier pass, and use its retained IDs as the review target. Report `refinementYield = refinementDropped / primaryRetained`; if it is below 0.30 mark `lowYield:true` and do not add more classifier stages. A large retained set alone is not authorization for refinement. Otherwise use primary retained IDs.
5. In that same screening execution call `screen_review_start({preset, scope, reviewTargetIds})` exactly once. The extension now owns semantic-review state. Return only the compact `workflowId`, primary/refinement counts, and progress.

Nested Code Mode tool results may be JSON strings. When composition requires a nested structured result, normalize once with `typeof raw === "string" ? JSON.parse(raw) : raw`. Do not infer structure from a summary string.

## Extension-owned review state

After `screen_review_start`, the model must not maintain semantic-review accounting. Do not store or merge `reviewedIds`, `evidenceSeenIds`, `needsExpandedEvidenceIds`, `blockedEvidenceIds`, `pendingPacketIds`, findings, offsets, or packet counters in Code Mode.

The extension owns these invariants:

- `reviewedIds ⊆ evidenceSeenIds`;
- standard `INSUFFICIENT_EVIDENCE` is queued for expanded evidence;
- expanded `INSUFFICIENT_EVIDENCE` is quarantined per ID without stopping independent targets;
- blocked IDs remain unreviewed;
- only `CONFIRM` creates findings;
- pending packet identity and exact disposition coverage are validated atomically;
- repeated `screen_review_next` before commit returns the same pending packet rather than advancing;
- terminal status is `complete` or `review_complete_with_blocked_evidence`.

Review workflow state is process-local to the active Pi session. Context compaction does not lose it. Restarting the Pi process clears it.

## Semantic review loop

Use `screen_review_next` and `screen_review_commit` directly for semantic review; no Code Mode state machine is needed.

1. Call `screen_review_next({workflowId})`. On later `/screen-continue` turns the `workflowId` may be omitted to resume the latest active workflow in this Pi session.
2. If status is `packet`, read only that packet's emitted `reviewContract` and evidence. Apply the contract exactly. Produce exactly one `{id, disposition, rationale}` for every returned packet ID.
3. Call `screen_review_commit({workflowId, packetId, dispositions})` exactly once. Do not call `screen_review_apply`, do not hand-write coverage validation, and do not update review sets manually.
4. If commit returns `ready`, call `screen_review_next` for the next packet. If commit returns `complete` or `review_complete_with_blocked_evidence`, stop and report its compact final progress/findings/blocked summary.
5. Review at most three distinct packets or roughly 100-120 semantic dispositions in one user turn. If more work remains, return `resumeAvailable:true`; `/screen-continue` resumes through the latest extension-owned workflow with zero classifier, preflight, rediscovery, or model-owned state-merging calls.

`screen_review_next` is idempotent while a packet is pending. If a turn is interrupted after fetch but before commit, the next call returns the same packet and packet ID. A stale or duplicate commit fails closed and does not advance state.

A successful evidence packet may contain fewer IDs than the internal request because adapter/token bounds trim only at whole-item boundaries. This is normal. The extension validates returned packet/item identity before making it pending; the model does not compare requested count to returned count.

## Review contract

Each packet carries the preset's explicit `reviewContract`. Treat it as authoritative rather than substituting generic intuition.

- `CONFIRM`: hidden/changed failure semantics with a material core outward effect.
- `EXPLICIT_FAILURE`: the failure is surfaced or fail-closed.
- `UI_ONLY`: rendering/formatting/display-only effect without feedback into core data, persisted state, policy, screening, or execution.
- `OPTIONAL_ENRICHMENT`: best-effort enrichment whose absence cannot masquerade as a successful core result.
- `CLEANUP_RETRY_TELEMETRY`: cleanup, retry/reconnect, logging, telemetry.
- `EXPECTED_NORMALIZATION`: normalization explicitly allowed by the outward/source contract.
- `NO_OUTWARD_EFFECT`: evidence affirmatively establishes no core outward effect; missing context is not enough.
- `INSUFFICIENT_EVIDENCE`: evidence cannot establish confirmation or a terminal rejection.

For the Python-exceptions preset, silently dropping malformed authoritative records or returning an empty/default domain object after an authoritative persisted-state read/parse failure is not expected normalization unless omission/defaulting is explicitly permitted and surfaced.

## Low-level tools

`screen_evidence` and `screen_review_apply` remain available as low-level APIs and for tests/ad-hoc integrations. Canonical preset workflows must use `screen_review_start` / `screen_review_next` / `screen_review_commit` instead, so review state ownership stays inside the extension.

## Ad-hoc `/screen`

For tasks without a preset, `screen_batch` remains available directly. The caller is responsible for stable, self-contained candidate text and review evidence. Do not claim deterministic adapter/review-state guarantees for an ad-hoc workflow.
