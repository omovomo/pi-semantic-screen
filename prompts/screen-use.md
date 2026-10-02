---
description: Run a registered semantic-screen preset through its deterministic adapter
argument-hint: "<preset> [scope] [--refine]"
---

Run the installed `ask` skill state machine with preset `$1`, scope `${2:-.}`, and options `${@:3}`.

Use only `screen_preset`, `screen_discover`, `screen_preflight`, `screen_batch`, and `screen_evidence` for the preset workflow. Do not recreate the preset's discovery/evidence logic in Code Mode or shell scripts.

Use **one Code Mode call per structured stage**; never call a tool directly for a preview and then repeat the same call inside Code Mode. First Code Mode stage: `screen_preset` + `screen_discover(..., mode:"count")` + `screen_preflight`, returning only compact approval/count data and stopping when approval is required. After approval, one Code Mode stage must call `screen_discover(..., mode:"candidates")` once + the canonical `screen_batch` once, then store compact review state under `semantic_screen_review_state`.

Run refinement only when `${@:3}` explicitly contains `--refine` and the preset defines a refinement stage; it requires its own preflight/approval when above the guard. Otherwise `reviewTarget = primary retained`.

Review deterministic packets from `screen_evidence` under the preset's review instructions. Fetch each packet exactly once inside Code Mode; persist its exact `packetIds` in the same execution and emit the evidence once for parent review. Never do direct `screen_evidence` + Code Mode `screen_evidence` for the same packet. Commit only IDs from exact emitted `packetIds`, maintain `reviewedIds ⊆ evidenceSeenIds`, and pause with exact `resumeAvailable:true` after roughly 120 semantic dispositions / two large packets if work remains. Never store or repeat raw candidate/evidence payloads after disposition.
