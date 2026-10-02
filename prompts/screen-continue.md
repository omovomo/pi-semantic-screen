---
description: Continue the most recent semantic review without rediscovery or rescreening
argument-hint: ""
---

Resume the latest extension-owned semantic review. Do not call `screen_preset`, `screen_preflight`, `screen_discover`, `screen_batch`, `screen_evidence`, or `screen_review_apply`. Make zero classifier calls and zero rediscovery passes.

Call `screen_review_next({})`; omitting `workflowId` selects the latest active review workflow in this Pi session. If it returns `error` with no active workflow, return only `status: no_resumable_screen_state`.

For each returned `packet`, apply its emitted `reviewContract` and produce exactly one `{id, disposition, rationale}` per packet ID. Then call `screen_review_commit({workflowId, packetId, dispositions})` exactly once. The extension atomically owns reviewed/evidence-seen accounting, expanded-evidence priority, blocked quarantine, findings, and terminal detection. Never maintain or merge those sets in Code Mode.

If commit returns `ready`, fetch the next packet and continue. Process at most three distinct packets / roughly 100-120 dispositions in this turn. If work remains, return its compact progress with `resumeAvailable:true`. If status is `complete` or `review_complete_with_blocked_evidence`, return `resumeAvailable:false` with the final compact progress/findings/blocked summary returned by the extension.

If a previous turn fetched a packet but did not commit it, `screen_review_next` returns the same pending packet and packet ID; do not rediscover or invent coverage.
