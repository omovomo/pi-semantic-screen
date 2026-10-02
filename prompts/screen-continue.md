---
description: Continue the most recent semantic review without rediscovery or rescreening
argument-hint: ""
---

Load `semantic_screen_review_state` in Code Mode. If no resumable state exists, return only `status: no_resumable_screen_state`.

Do not call `screen_preflight`, `screen_discover`, or `screen_batch`. This command must make zero classifier calls and zero rediscovery passes.

In one Code Mode execution load the stored state, call `screen_preset` once if preset data is needed, compute remaining `reviewTargetIds - reviewedIds`, and continue only through `screen_evidence`: make a single `screen_evidence` call for the next packet. Do not make direct preview calls to `screen_preset` or `screen_evidence` and then repeat them in Code Mode. A successful fetch's exact `packetIds` become `pendingPacketIds` and are the only new IDs eligible for commit after actual semantic disposition. Maintain `reviewedIds ⊆ evidenceSeenIds`; never infer coverage from requested batch length or offsets.

Process up to about 120 semantic dispositions / two large packets in this turn unless review completes sooner. Store compact progress/findings only. Return `reviewTarget`, `semanticallyReviewed`, `confirmed`, `unreviewed`, `resumeAvailable`, and only newly substantiated findings. Set `resumeAvailable:false` only when reviewed IDs exactly cover review-target IDs.
