# Agent notes

This repository is a Pi package. Before changing runtime behavior, read `README.md`, `docs/architecture.md`, and the relevant adapter/preset documentation.

## Architectural invariants

- Keep `screen_batch` generic; it must not know about Python, exceptions, files, or any specific audit.
- Deterministic source discovery/evidence belongs in adapters under `src/adapters/`.
- Semantic questions, thresholds, and review policy belong in presets under `src/presets/`.
- Prompt templates should orchestrate registered tools; do not copy source parsers or AST logic into prompts.
- `/screen-exceptions` is an alias for the `python-exceptions` preset and should stay small.
- Preserve fail-closed accounting: errors/withheld/undecided are unresolved, never silently dropped.
- Preserve `reviewedIds ⊆ evidenceSeenIds` and exact packet membership.
- Refinement remains opt-in.
- Host context management is the default. Do not enable extension compaction unless explicitly configured.

## Required checks

Run before packaging:

```sh
npm test
npm run typecheck:offline
npm run pack:dry
```

If a full Pi development environment is available, also run:

```sh
npm run typecheck
npm run test:codemode
```
