---
description: Run a registered semantic-screen preset through its deterministic adapter
argument-hint: "<preset> [scope] [--refine]"
---

Run the installed `ask` skill state machine with preset `$1`, scope `${2:-.}`, and options `${@:3}`.

Use only `screen_preset`, `screen_discover`, `screen_preflight`, `screen_batch`, and `screen_evidence` for the preset workflow. Do not recreate the preset's discovery/evidence logic in Code Mode or shell scripts.

Load the preset first. Count through `screen_discover(..., mode:"count")`, preflight that count, and stop compactly for approval when required. After approval discover candidates once, run the canonical primary classifier stage once, and store compact review state under `semantic_screen_review_state`.

Run refinement only when `${@:3}` explicitly contains `--refine` and the preset defines a refinement stage; it requires its own preflight/approval when above the guard. Otherwise `reviewTarget = primary retained`.

Review deterministic packets from `screen_evidence` under the preset's review instructions. Commit only IDs from exact emitted `packetIds`, maintain `reviewedIds ⊆ evidenceSeenIds`, and pause with exact `resumeAvailable:true` after roughly 120 semantic dispositions / two large packets if work remains. Never store or repeat raw candidate/evidence payloads after disposition.
