# Presets

A preset contains semantic policy, not source traversal or workflow-state logic.

A preset defines:

- `id`, label, description;
- adapter ID;
- primary classifier question / true-false criteria / threshold;
- optional opt-in refinement stage;
- review `instructions`, `confirmWhen`, `rejectWhen`;
- evidence packet defaults (`targetItems`, source/character caps, token budget).

The canonical flow performs count-only discovery/preflight, then `screen_primary_start` loads the preset again inside the extension, performs candidate discovery internally, applies the exact preset primary contract, computes retained IDs, and starts review. The model never copies the preset question/criteria/threshold or retained IDs. The preset's review policy is embedded into every packet returned by `screen_review_next`.

## Adding a preset

If an existing adapter already produces the candidate/evidence semantics you need, add only a new preset under `src/presets/` and register it. Do not clone `/screen-use` or implement a new state machine.

A use-case-specific alias prompt is optional and should stay tiny.

## Refinement

Refinement is opt-in. A large retained set does not authorize another classifier pass. If refinement is requested, primary initialization is deferred and `screen_refinement_start` runs the exact preset refinement contract over extension-owned retained primary candidates. Refinement has its own call guard/approval boundary and starts review from its exact retained IDs without model reconstruction.

## Review contract

At runtime the extension combines the preset review policy with the generic disposition vocabulary:

```text
CONFIRM
EXPLICIT_FAILURE
UI_ONLY
OPTIONAL_ENRICHMENT
CLEANUP_RETRY_TELEMETRY
EXPECTED_NORMALIZATION
NO_OUTWARD_EFFECT
INSUFFICIENT_EVIDENCE
```

Only `CONFIRM` creates a finding. Standard `INSUFFICIENT_EVIDENCE` is automatically routed to expanded evidence; expanded insufficiency is quarantined per ID without stopping independent targets.

For `python-exceptions`, `EXPECTED_NORMALIZATION` is intentionally narrow. Silently omitting malformed authoritative records or returning a normal empty/default domain object after failed authoritative persisted-state loading is not normalization unless the outward/source contract explicitly allows and surfaces that behavior.
