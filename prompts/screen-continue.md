---
description: Continue the most recent semantic review without rediscovery or rescreening
argument-hint: ""
---

Load `semantic_screen_review_state` in Code Mode. If no resumable state exists, return only `status: no_resumable_screen_state`.

Do not call `screen_preset`, `screen_preflight`, `screen_discover`, or `screen_batch`. Use the stored preset id/scope/config. This command must make zero classifier calls and zero rediscovery passes.

Continue only through `screen_evidence`. The rule is **single-call-per-packet, not single-packet-per-turn**: each distinct packet may be fetched exactly once, while up to three different packets may be reviewed in this same user turn. For each packet:

1. In Code Mode, if unblocked `needsExpandedEvidenceIds` is non-empty, select those still-unreviewed IDs first and call `screen_evidence({preset: state.preset, scope: state.scope, ids, detail:"expanded"})`; otherwise compute remaining `reviewTargetIds - reviewedIds - blockedEvidenceIds` in stable order and call standard `screen_evidence` once. Do not preview it directly first. Never automatically refetch `blockedEvidenceIds`.
2. Store only its exact `packetIds` as `pendingPacketIds`; do **not** add them to `evidenceSeenIds` yet. Emit the bounded evidence once for parent review.
3. If the Code Mode/tool output contains a truncation warning, `estimatedTokens > tokenBudget`, or the visible evidence item IDs do not exactly equal `pendingPacketIds`, fail closed: do not disposition/commit those IDs, clear pending state, and retry the same remaining IDs with a lower `maxTokens` budget.
4. Apply the emitted `reviewContract` to every item and produce exactly one `{id, disposition, rationale}` per `pendingPacketId`. Code Mode must reject any missing/duplicate/extra disposition ID. Terminal dispositions are unioned into both `evidenceSeenIds` and `reviewedIds` and removed from `needsExpandedEvidenceIds`; only `CONFIRM` is appended as a finding. Standard-detail `INSUFFICIENT_EVIDENCE` is unioned into `evidenceSeenIds` only, remains unreviewed, and is added to `needsExpandedEvidenceIds` for priority refetch with `detail:"expanded"`. Expanded-detail `INSUFFICIENT_EVIDENCE` is fail-closed **for that ID only**: keep it unreviewed, remove it from `needsExpandedEvidenceIds`, add it to `blockedEvidenceIds` plus a compact blocked rationale, and continue the independent queue. Never stop the entire workflow merely because blocked IDs exist.
5. Clear `pendingPacketIds`. If useful budget remains, fetch the next distinct packet in the same assistant turn and repeat.

If a prior interrupted state already contains non-empty `pendingPacketIds` but its raw evidence is no longer present for review, clear that pending set and refetch those still-unreviewed IDs; never infer that they were seen.

Maintain `reviewedIds ⊆ evidenceSeenIds`, `blockedEvidenceIds ⊆ evidenceSeenIds`, and `blockedEvidenceIds ∩ reviewedIds = ∅`; never infer coverage from requested batch length, offsets, packet counts, or prior state alone. Stop after roughly 100-120 semantic dispositions or **at most three** evidence packets in this turn, or sooner when no actionable targets remain. Store compact progress/findings/blocked reasons only. Return `reviewTarget`, `semanticallyReviewed`, `confirmed`, `blockedEvidence`, `unreviewed`, `resumeAvailable`, and only newly substantiated findings. If actionable IDs remain, set `resumeAvailable:true`. If none remain, set `resumeAvailable:false` and return `status:complete` when `blockedEvidenceIds` is empty, otherwise `status:review_complete_with_blocked_evidence`.
