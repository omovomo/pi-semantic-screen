---
name: ask
description: Use pi-semantic-screen presets/adapters to cheaply screen many candidates, then review deterministic evidence with exact resumable accounting.
---

# Semantic screening workflow

Prefer the preset/adapter path whenever the task matches an installed preset. Presets contain the semantic questions and review policy; adapters own deterministic discovery and evidence extraction. Do not reimplement adapter logic in Code Mode, Python, PowerShell, grep, or ad-hoc AST code when `screen_discover` / `screen_evidence` can do it.

## Canonical preset flow

Preset workflows are **single-call-per-stage** and **single-call-per-packet**. When a structured tool result is needed for Code Mode state or composition, call that tool from Code Mode the first time; never make a direct preview call and then repeat the same `screen_preset`, `screen_discover`, `screen_preflight`, `screen_batch`, or `screen_evidence` call inside Code Mode. Single-call-per-packet does not mean one packet per user turn: multiple distinct packets may be reviewed in one turn.

1. In one Code Mode execution, call `screen_preset({id})` exactly once for the workflow. Store its compact primary/refinement/review/evidence config in `semantic_screen_review_state`; later stages must reuse that config rather than call `screen_preset` again. Then call `screen_discover({preset:id, scope, mode:"count"})`, then `screen_preflight({count})` before constructing candidate text. Return only compact status/counts. If approval is required, stop. No classifier calls are allowed before approval.
2. After approval, in one Code Mode execution call `screen_discover({preset:id, scope, mode:"candidates"})` once and immediately call `screen_batch` once with the stored preset primary question/criteria/threshold. Keep candidate data inside that execution and store only compact review state.
3. The first successful primary result is canonical. Do not repeat it unless the user explicitly requests a fresh run with `rescreen:true`.
4. Define primary retained IDs as `kept + undecided + withheld + errors`. Bucket entries can be objects; normalize IDs from `entry.id` rather than feeding result objects back into `screen_batch`.
5. By default set `reviewTarget = retained` and begin semantic review. Refinement is opt-in only; use a preset refinement stage only when the user explicitly requested `--refine` or an equivalent extra screening pass. A large retained set alone is not authorization for more classifier calls.

If an adapter returns `status:"error"`, fail closed. Report its compact issues and do not classify or advance review state from partial discovery/evidence.

## Review state

Use Code Mode store key `semantic_screen_review_state`. Persist compact state only:

- preset id, adapter id, scope, workflow/phase and compact preset config;
- primary/refinement model and counts;
- `reviewTargetIds`, `reviewedIds`, `evidenceSeenIds`, exact `pendingPacketIds`;
- compact findings and progress metadata.

Never store candidate text, full classifier buckets, or raw evidence.

Exact invariants:

- primary `retained = kept + undecided + withheld + errors`;
- `reviewedIds ⊆ evidenceSeenIds`;
- a fetch sets only exact `pendingPacketIds`; pending IDs are not evidence-seen yet;
- a commit may contain only IDs from the exact previous `pendingPacketIds` after the parent actually inspected their complete emitted evidence;
- the same committed IDs are then unioned into both `evidenceSeenIds` and `reviewedIds`;
- `semanticallyReviewed = |unique reviewedIds|`;
- `unreviewed = reviewTarget - semanticallyReviewed`;
- `resumeAvailable:false` only when the reviewed-ID set exactly equals the review-target set.

Never infer reviewed coverage from requested packet size, offsets, slices, packet count, or a successful fetch alone. An ID becomes reviewed only after the parent actually receives its complete evidence and reaches a semantic disposition.

## Evidence loop

Fetch evidence only with `screen_evidence`; do not regenerate source extractors in Code Mode. Request remaining review-target IDs in stable order. Use the preset's token budget by default; character/item/source caps remain secondary deterministic adapter safety limits. `screen_evidence` returns `tokenBudget` and `estimatedTokens` for its exact structured packet.

**Fetch each evidence packet exactly once from Code Mode.** Do not call `screen_evidence` directly for a preview and then repeat it in Code Mode. In the same fetch execution, set `pendingPacketIds` to the exact returned IDs and emit the bounded evidence once for parent semantic review. Do not add pending IDs to `evidenceSeenIds` yet.

Transport integrity is fail-closed. If Code Mode/tool output says it was truncated, if `estimatedTokens > tokenBudget`, or if the visible evidence item IDs do not exactly equal `pendingPacketIds`, do not disposition or commit that packet. Clear pending state and retry the same remaining IDs with a lower `maxTokens` budget. A transport-truncated packet can never advance `reviewedIds` or `evidenceSeenIds`.

After the parent actually inspects every complete emitted item and assigns a semantic disposition, one Code Mode execution must validate the dispositions against the exact prior `pendingPacketIds`, union those IDs into both `evidenceSeenIds` and `reviewedIds`, append only substantiated findings, and clear pending. It may then fetch the next distinct `screen_evidence` packet in that same execution so the parent can continue review.

Pipeline multiple distinct packets in one user turn when practical. Default stop budget: roughly 100-120 semantic dispositions or three evidence packets, unless review completes sooner. If targets remain, save state and return `resumeAvailable:true`; `/screen-continue` must use the stored preset id/config and make zero `screen_preset`, classifier, preflight, or rediscovery calls.

If a continuation starts with non-empty `pendingPacketIds` but the raw packet is no longer available to the parent (for example after interruption/compaction), clear pending and refetch those still-unreviewed IDs. Never treat stale pending IDs as seen.

Do not repeat committed raw evidence in later output. Return compact progress and newly substantiated findings only.

## Refinement

When explicitly requested and the preset defines `refinement`:

- preflight the retained count separately and obtain separate approval when required;
- if candidate text is no longer in Code Mode memory, call `screen_discover(..., mode:"candidates")` at most once and select retained IDs;
- run one stricter `screen_batch` with the preset refinement stage;
- `reviewTarget = refinement kept + undecided + withheld + errors`;
- report `refinementYield = refinementDropped / primaryRetained`; if below 0.30 mark `lowYield:true` and do not add more classifier stages.

Refinement is screening, not semantic review.

## Ad-hoc `/screen`

For tasks without a preset, `screen_batch` remains available directly. The caller is then responsible for producing stable, self-contained candidate text and review evidence. Do not pretend an ad-hoc workflow has deterministic adapter guarantees that it does not have.
