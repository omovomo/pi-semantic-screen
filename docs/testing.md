# Testing

Install the committed development dependencies first:

```sh
npm ci
```

Run the standard offline checks:

```sh
npm test
npm run typecheck:offline
npm run pack:dry
```

Or:

```sh
npm run check
```

## What the test suite covers

The suite includes:

- classifier bucket/accounting/fail-closed behavior;
- redaction, abort, concurrency and per-candidate classifier-result reuse/invalidation;
- preflight approval guard;
- evidence-provider deterministic discovery/evidence, API-version validation, bounded-source failures, and stale/syntax failures;
- declarative preset loading and the adapterless JS/TS proof use case;
- classifier-first efficiency metrics and honest usage accounting;
- evidence token bounding and review-contract overhead;
- exact review disposition validation;
- extension-owned review workflow transitions;
- idempotent pending packet retrieval;
- stale packet commit rejection;
- standard-insufficient -> expanded priority;
- expanded-insufficient -> blocked quarantine without global stop;
- terminal findings/blocked/disposition accounting plus standard/expanded efficiency metrics;
- generic semantic-stability comparison;
- prompt/skill contract tests preventing model-owned preset-contract/retained-ID/review-state reconstruction;
- package metadata and tool exposure.

## Full regression audit

After unit checks, load the package in Pi and run:

```text
/screen-exceptions my_project/
```

Approve the classifier batch when requested, then use:

```text
/screen-continue
```

until terminal status.

For a full JSONL regression, verify:

```text
screen_preset          1
screen_discover        1 (count only; candidate discovery is internal)
screen_preflight       1
screen_primary_start   1
screen_refinement_start 0 unless `--refine`
screen_batch           0 in canonical preset initialization
screen_review_start    0 in canonical preset initialization
screen_review_next     one per distinct/retried pending packet
screen_review_commit   one per committed packet
screen_evidence        0 in canonical preset review
screen_review_apply    0 in canonical preset review
PowerShell/generated AST 0
```

Also verify:

- no duplicate evidence build when `screen_review_next` is repeated before commit;
- no model-supplied preset question/criteria/threshold, retained IDs, or manual `reviewedIds`/blocked/expanded queue mutations in Code Mode;
- no stale/empty-ID fetches;
- primary counts/workflow ID come from `screen_primary_start` (or `screen_refinement_start`), and exact terminal review progress comes from `screen_review_commit`/`screen_review_next`;
- representative explicit-failure, authoritative-record omission, fallback/default, UI-only, and ambiguous-dataflow cases receive evidence/dispositions consistent with the preset contract.

## Full development environment

When Pi development dependencies are available locally, also run:

```sh
npm run typecheck
npm run test:codemode
```
