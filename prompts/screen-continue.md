---
description: Continue the most recent semantic review without rediscovery or rescreening
argument-hint: ""
---

Load `semantic_screen_review_state` in Code Mode. If no resumable state exists, return only `status: no_resumable_screen_state`.

Do not call `screen_preset`, `screen_preflight`, `screen_discover`, or `screen_batch`. Use the stored preset id/scope/config. This command must make zero classifier calls and zero rediscovery passes.

Continue only through `screen_evidence`. The rule is **single-call-per-packet, not single-packet-per-turn**: each distinct packet may be fetched exactly once, while up to three different packets may be reviewed in this same user turn. For each packet:

1. In Code Mode compute remaining `reviewTargetIds - reviewedIds` in stable order and call `screen_evidence({preset: state.preset, scope: state.scope, ids: remaining})` once. Do not preview it directly first.
2. Store only its exact `packetIds` as `pendingPacketIds`; do **not** add them to `evidenceSeenIds` yet. Emit the bounded evidence once for parent review.
3. If the Code Mode/tool output contains a truncation warning, `estimatedTokens > tokenBudget`, or the visible evidence item IDs do not exactly equal `pendingPacketIds`, fail closed: do not disposition/commit those IDs, clear pending state, and retry the same remaining IDs with a lower `maxTokens` budget.
4. After the parent actually inspects every emitted item and assigns a semantic disposition, commit exactly those `pendingPacketIds`: union them into both `evidenceSeenIds` and `reviewedIds`, append only newly substantiated findings, and clear `pendingPacketIds`.
5. If useful budget remains, fetch the next distinct packet in the same assistant turn and repeat.

If a prior interrupted state already contains non-empty `pendingPacketIds` but its raw evidence is no longer present for review, clear that pending set and refetch those still-unreviewed IDs; never infer that they were seen.

Maintain `reviewedIds ⊆ evidenceSeenIds`; never infer coverage from requested batch length, offsets, packet counts, or prior state alone. Stop after roughly 100-120 semantic dispositions or three evidence packets in this turn, or sooner if review completes. Store compact progress/findings only. Return `reviewTarget`, `semanticallyReviewed`, `confirmed`, `unreviewed`, `resumeAvailable`, and only newly substantiated findings. Set `resumeAvailable:false` only when reviewed IDs exactly cover review-target IDs.
