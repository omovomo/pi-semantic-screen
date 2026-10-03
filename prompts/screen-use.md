---
description: Run a registered semantic-screen preset through its deterministic adapter
argument-hint: "<preset> [scope] [--refine]"
---

Run the installed `ask` skill workflow with preset `$1`, scope `${2:-.}`, and options `${@:3}`.

Before approval, use one Code Mode stage for `screen_preset` + count-only `screen_discover` + `screen_preflight`. No rich candidate text or classifier calls before the guard is satisfied.

For the normal path, initialize with `screen_primary_start({preset:$1, scope:${2:-.}, confirm})`. Use `confirm:true` only after explicit approval; if preflight returned `ok`, use `confirm:false`. Do not call candidate-mode `screen_discover`, `screen_batch`, or `screen_review_start` in the canonical preset path: `screen_primary_start` owns exact preset question/criteria/threshold, retained IDs, and review initialization.

For explicit `--refine`, call primary start with `deferReview:true`, then call `screen_refinement_start({primaryRunId, confirm:false})`. If refinement returns `approval_required`, request explicit approval and retry it once with `confirm:true`. Never rebuild the refinement contract or retained candidates in model code.

After successful initialization, review packets directly through `screen_review_next` → one contract disposition per returned ID → `screen_review_commit`. Do not use low-level `screen_evidence` or `screen_review_apply` for the canonical preset workflow.

Process at most three packets / roughly 100-120 dispositions per user turn. If more remain, return `resumeAvailable:true`; `/screen-continue` resumes the extension-owned workflow with zero classifier/rediscovery calls. At terminal status report compact progress plus findings and blocked-evidence summary returned by the extension.
