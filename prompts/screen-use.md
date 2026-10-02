---
description: Run a registered semantic-screen preset through its deterministic adapter
argument-hint: "<preset> [scope] [--refine]"
---

Run the installed `ask` skill state machine with preset `$1`, scope `${2:-.}`, and options `${@:3}`.

Use only `screen_preset`, `screen_discover`, `screen_preflight`, `screen_batch`, and `screen_evidence` for the preset workflow. Do not recreate the preset's discovery/evidence logic in Code Mode or shell scripts.

Use **one Code Mode call per structured stage**; never call a tool directly for a preview and then repeat the same call inside Code Mode. First Code Mode stage: call `screen_preset` once, store its compact primary/refinement/review/evidence config in `semantic_screen_review_state`, then call `screen_discover(..., mode:"count")` + `screen_preflight`, returning only compact approval/count data and stopping when approval is required. Later stages must reuse the stored preset config rather than call `screen_preset` again.

After approval, one Code Mode stage must call `screen_discover(..., mode:"candidates")` once + the canonical `screen_batch` once, then store compact review state. Run refinement only when `${@:3}` explicitly contains `--refine` and the preset defines a refinement stage; it requires its own preflight/approval when above the guard. Otherwise `reviewTarget = primary retained`.

Review deterministic packets from `screen_evidence` under the packet's explicit `reviewContract`. Evidence is transport-bounded by the preset token budget; character/item/source caps are secondary adapter safety bounds. The rule is **single-call-per-packet, not single-packet-per-turn**: fetch each distinct packet exactly once inside Code Mode, persist only its exact `packetIds` as `pendingPacketIds`, and emit the evidence plus `reviewContract` once for parent review. Do not add pending IDs to `evidenceSeenIds` until the parent has actually received the complete packet and assigned exactly one contract disposition per ID.

If the tool/Code Mode output is truncated, `estimatedTokens > tokenBudget`, or visible evidence item IDs do not exactly match `pendingPacketIds`, fail closed: do not commit those IDs; clear pending state and retry the same remaining IDs with a lower `maxTokens`. Otherwise commit only the exact dispositioned `pendingPacketIds`: terminal dispositions advance both `evidenceSeenIds` and `reviewedIds`; standard-detail `INSUFFICIENT_EVIDENCE` advances `evidenceSeenIds` only and queues `needsExpandedEvidenceIds`; expanded-detail `INSUFFICIENT_EVIDENCE` moves to `blockedEvidenceIds` with a compact reason and does not advance `reviewedIds`. Clear pending and continue with independent targets. Maintain `reviewedIds ⊆ evidenceSeenIds`, `blockedEvidenceIds ⊆ evidenceSeenIds`, and `blockedEvidenceIds ∩ reviewedIds = ∅`.

Within one user turn, pipeline up to three distinct evidence packets / roughly 100-120 semantic dispositions when possible. Never store or repeat raw candidate/evidence payloads after disposition. Pause with `resumeAvailable:true` only while actionable targets remain. When all targets are either reviewed or blocked, return `resumeAvailable:false` with `status:complete` if none are blocked, otherwise `status:review_complete_with_blocked_evidence`; `/screen-continue` resumes without `screen_preset`, classifier calls, or rediscovery.
