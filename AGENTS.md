# Agent notes

This repository is a Pi package. Before changing runtime behavior, read `README.md`, `docs/architecture.md`, and the relevant adapter/preset documentation.

## Architectural invariants

- Keep the classifier/review core generic; it must not know target-language syntax, application concepts, exception-specific rejection labels, or classifier-vendor preferences. `screen_batch` remains a generic primitive.
- Deterministic source discovery/evidence belongs in providers under `src/providers/` or advanced compatibility adapters under `src/adapters/`.
- Semantic questions, thresholds, and review policy belong in presets. Compact presets default to `CONFIRM / REJECT / INSUFFICIENT_EVIDENCE`; specialized terminal rejection labels must remain preset-owned.
- Canonical preset screening must load primary/refinement contracts inside the extension; prompts/Code Mode must not serialize or reconstruct them.
- Canonical retained candidate IDs belong in `PresetScreeningWorkflowManager`; canonical semantic-review state belongs in `ReviewWorkflowManager`.
- The parent model may assign semantic dispositions but must not maintain `reviewedIds`, expanded queues, blocked IDs, packet offsets, or findings.
- `screen_review_next` must be idempotent while a packet is pending.
- `screen_review_commit` must fail closed on stale packet IDs or non-exact disposition coverage.
- Preserve `reviewedIds ⊆ evidenceSeenIds`; blocked IDs remain evidence-seen but unreviewed.
- `/screen-exceptions` is an alias for `python-exceptions` and must stay small.
- Refinement remains opt-in and uses extension-owned retained candidates plus the exact preset refinement contract.
- Host context management is the default; do not enable extension compaction unless explicitly configured.
- Keep `generic-source` text/regex/literal based and ecosystem-neutral. Do not add JS/TS, Python, C/C++, or other language parser semantics to it.
- Prefer compact declarative presets for new use cases. A new provider requires a genuinely new deterministic fact boundary.
- Treat classifier review avoidance as first-class product value: report `reviewAvoided` and `reviewAvoidanceRate`, audit DROP safety, and never optimize reduction by weakening fail-closed semantics.

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
