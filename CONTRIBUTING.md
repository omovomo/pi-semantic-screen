# Contributing

## Development requirements

- Node.js 22.19 or newer.
- Python 3.9 or newer for the built-in `python-exceptions` adapter and its tests.
- A Pi installation is optional for offline tests and required for the live Code Mode smoke test.

Install development dependencies:

```sh
npm install --ignore-scripts --legacy-peer-deps
```

Run the required checks:

```sh
npm run check
```

When a Pi host is available, additionally run:

```sh
npm run typecheck
npm run test:codemode
```

## Adding a use case

Start with the smallest generic path.

1. Create a compact declarative preset, normally project-local under `.pi-semantic-screen/presets/<id>.json`. Prefer `source.find` for literal discovery and `source.match` only when regex is needed.
2. Keep the semantic question and optional bounded `dropHints` in the preset. Do not move business meaning into discovery code.
3. Use an existing evidence provider if bounded text/source facts are sufficient.
4. Use an advanced preset when you need explicit evidence limits, a specialized existing provider, refinement, or a richer preset-owned review vocabulary.
5. Add a new provider only when a genuinely new deterministic fact cannot be represented safely by the existing provider boundary. Do not add a target-language parser, call graph, or dataflow subsystem to `generic-source`.
6. If a structural concept is language-neutral but its implementation is language-specific, define a narrow capability/resolver boundary first; unsupported languages must fail closed.
7. Validate classifier value on a representative corpus: report `reviewAvoided` and `reviewAvoidanceRate`, audit DROP safety, and do not increase reduction at the expense of recall/fail-closed behavior.

A new use case should normally require preset data, not TypeScript changes to the extension. See `docs/presets.md`, `docs/adapters.md`, and `docs/universality.md`.

## Pull requests

Keep changes focused and preserve the invariants in `AGENTS.md`. Include tests for behavioral changes. Do not commit generated archives, `node_modules`, credentials, or project candidate/evidence dumps.

## Licensing

This project is licensed under the MIT License. By contributing, you agree that your contributions will be licensed under the same MIT terms.
