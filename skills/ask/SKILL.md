---
name: ask
description: Use pi-semantic-screen presets/adapters to cheaply screen many candidates, then review deterministic evidence with exact resumable accounting.
---

# Semantic screening workflow

Prefer the preset/adapter path whenever the task matches an installed preset. Presets contain the semantic questions and review policy; adapters own deterministic discovery and evidence extraction. Do not reimplement adapter logic in Code Mode, Python, PowerShell, grep, or ad-hoc AST code when `screen_discover` / `screen_evidence` can do it.

## Canonical preset flow

1. `screen_preset({id})` to load the preset.
2. `screen_discover({preset:id, scope, mode:"count"})`.
3. `screen_preflight({count})` before constructing candidate text. If approval is required, return only compact approval counts and stop. No classifier calls are allowed before approval.
4. After approval, `screen_discover({preset:id, scope, mode:"candidates"})` once. Keep the returned candidate array inside Code Mode.
5. Call `screen_batch` once with the preset primary question/criteria/threshold. The first successful primary result is canonical. Do not repeat it unless the user explicitly requests a fresh run with `rescreen:true`.
6. Define primary retained IDs as `kept + undecided + withheld + errors`. Bucket entries can be objects; normalize IDs from `entry.id` rather than feeding result objects back into `screen_batch`.
7. By default set `reviewTarget = retained` and begin semantic review. Refinement is opt-in only; use a preset refinement stage only when the user explicitly requested `--refine` or an equivalent extra screening pass. A large retained set alone is not authorization for more classifier calls.

If an adapter returns `status:"error"`, fail closed. Report its compact issues and do not classify or advance review state from partial discovery/evidence.

## Review state

Use Code Mode store key `semantic_screen_review_state`. Persist compact state only:

- preset id, adapter id, scope, workflow/phase;
- primary/refinement model and counts;
- `reviewTargetIds`, `reviewedIds`, `evidenceSeenIds`, exact `pendingPacketIds`;
- compact findings and progress metadata.

Never store candidate text, full classifier buckets, or raw evidence.

Exact invariants:

- primary `retained = kept + undecided + withheld + errors`;
- `reviewedIds ⊆ evidenceSeenIds`;
- a commit may contain only IDs from the exact previous `pendingPacketIds`;
- `semanticallyReviewed = |unique reviewedIds|`;
- `unreviewed = reviewTarget - semanticallyReviewed`;
- `resumeAvailable:false` only when the reviewed-ID set exactly equals the review-target set.

Never infer reviewed coverage from requested packet size, offsets, or slices. An ID becomes reviewed only after the parent actually inspects its emitted evidence and reaches a semantic disposition.

## Evidence loop

Fetch evidence only with `screen_evidence`; do not regenerate source extractors in Code Mode. Request remaining review-target IDs in stable order. Use the preset's evidence limits unless the user explicitly changes them.

Each successful fetch returns exact `packetIds` and evidence items actually emitted after source/character caps. Set `pendingPacketIds` to those exact IDs and union only them into `evidenceSeenIds`. Review the packet using the preset review instructions and confirmation criterion.

After the first packet, pipeline bookkeeping when practical: one Code Mode execution may validate/commit the previous packet and fetch the next `screen_evidence` packet. Keep progress meaningful rather than tiny fixed batches. Default per user turn: up to about 120 semantic dispositions or two large evidence packets, unless review completes sooner. If targets remain, save state and return `resumeAvailable:true`; `/screen-continue` resumes with zero classifier calls and zero rediscovery.

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
