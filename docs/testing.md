# Testing

## Required offline checks

```sh
npm test
npm run typecheck:offline
npm run pack:dry
```

These checks cover:

- classifier engine invariants;
- preflight guard;
- process-local screening reuse;
- extension tool registration;
- preset/adapter registries;
- Python exception count/candidate/evidence behavior;
- exact evidence packet IDs and caps;
- fail-closed Python syntax failures;
- prompt/skill architecture boundaries.

## Host checks

With a matching Pi installation and development dependencies:

```sh
npm run typecheck
npm run test:codemode
```

The Code Mode smoke test is optional in environments where the `pi` executable or classifier credentials are unavailable.

## Regression test strategy

Do not rerun an expensive full-project semantic audit for every documentation-only change.

Run a full real-project regression when changing:

- adapter candidate identity/content;
- evidence extraction;
- preset semantic questions/thresholds;
- screening/review state accounting;
- Pi tool boundary behavior.

For ordinary repository/docs changes, the offline suite and package dry-run are sufficient.
