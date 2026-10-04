# Agent notes

This repository is a Pi package. Before changing runtime behavior, read `README.md`, `docs/architecture.md`, and the relevant adapter/preset documentation.

## Architectural invariants

- Keep `screen_batch` generic; it must not know about Python, exceptions, files, or specific audits.
- Deterministic source discovery/evidence belongs in providers under `src/providers/` or advanced compatibility adapters under `src/adapters/`.
- Semantic questions, thresholds, and review policy belong in presets under `src/presets/`.
- Canonical preset screening must load primary/refinement contracts inside the extension; prompts/Code Mode must not serialize or reconstruct them.
- Canonical retained candidate IDs belong in `PresetScreeningWorkflowManager`; canonical semantic-review state belongs in `ReviewWorkflowManager`.
- The parent model may assign semantic dispositions but must not maintain `reviewedIds`, expanded queues, blocked IDs, packet offsets, or findings.
- `screen_review_next` must be idempotent while a packet is pending.
- `screen_review_commit` must fail closed on stale packet IDs or non-exact disposition coverage.
- Preserve `reviewedIds ⊆ evidenceSeenIds`; blocked IDs remain evidence-seen but unreviewed.
- `/screen-exceptions` is an alias for `python-exceptions` and must stay small.
- Refinement remains opt-in and uses extension-owned retained candidates plus the exact preset refinement contract.
- Host context management is the default; do not enable extension compaction unless explicitly configured.

## Required checks

```sh
npm ci
npm test
npm run typecheck:offline
npm run pack:dry
```

If a full Pi development environment is available:

```sh
npm run typecheck
npm run test:codemode
```
