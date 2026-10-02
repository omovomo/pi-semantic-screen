---
description: Run a registered semantic-screen preset through its deterministic adapter
argument-hint: "<preset> [scope] [--refine]"
---

Run the installed `ask` skill workflow with preset `$1`, scope `${2:-.}`, and options `${@:3}`.

Use `screen_preset`, `screen_discover`, `screen_preflight`, `screen_batch`, then `screen_review_start` for initialization. Do not recreate discovery/evidence logic in Code Mode or shell scripts.

Before approval, use one Code Mode stage for `screen_preset` + count discovery + preflight. After approval, use one Code Mode stage for candidates + exactly one canonical `screen_batch` **with `confirm:true`**, optional explicitly requested `--refine` refinement, and exactly one `screen_review_start` with the exact retained review-target IDs. Explicit approval must be propagated to the guarded classifier call through `confirm:true`; do not rely on conversational context alone. If a nested tool result is a JSON string, parse it once rather than reading fields from the string. Require `primary.status === "ok"` before computing retained IDs or starting review; for `approval_required` or `error`, stop with `reviewStarted:false` and do not call `screen_review_start`.

After `screen_review_start`, do not store semantic-review arrays/sets or manually merge review state. Review packets directly through `screen_review_next` → one contract disposition per returned ID → `screen_review_commit`. Do not use low-level `screen_evidence` or `screen_review_apply` for the canonical preset workflow.

Process at most three packets / roughly 100-120 dispositions per user turn. If more remain, return `resumeAvailable:true`; `/screen-continue` resumes the extension-owned workflow with zero classifier/rediscovery calls. At terminal status report compact progress plus findings and blocked-evidence summary returned by the extension.
