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

Do not start by creating another large prompt.

1. If an existing adapter can discover candidates and produce suitable evidence, add only a preset under `src/presets/` and register it in `src/presets/registry.ts`.
2. If deterministic extraction is genuinely new, add a small adapter implementing `ScreeningAdapter` under `src/adapters/`, then add a preset that references it.
3. Add a short alias prompt only when a memorable command is useful. The alias should delegate to `/screen-use`, not duplicate the workflow.
4. Add tests for discovery determinism, evidence packet IDs/caps, fail-closed behavior, and the preset registry.

See `docs/adapters.md` and `docs/presets.md`.

## Pull requests

Keep changes focused and preserve the invariants in `AGENTS.md`. Include tests for behavioral changes. Do not commit generated archives, `node_modules`, credentials, or project candidate/evidence dumps.

## Licensing

This project is licensed under the MIT License. By contributing, you agree that your contributions will be licensed under the same MIT terms.
