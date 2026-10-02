---
description: Run ad-hoc semantic batch screening when no registered preset fits
argument-hint: "<task>"
---

Use the installed `ask` skill for this ad-hoc task:

$@

Prefer `/screen-use <preset> ...` whenever an installed preset matches, because presets provide deterministic discovery/evidence adapters. For a genuinely ad-hoc task, discover stable self-contained candidates once, use `screen_preflight` before a large classifier batch, and call the canonical `screen_batch` once. Do not claim deterministic semantic-review coverage unless you also have a reliable evidence source for the candidate IDs.
