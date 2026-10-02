# Presets

A preset contains semantic policy, not source traversal or workflow-state logic.

A preset defines:

- `id`, label, description;
- adapter ID;
- primary classifier question / true-false criteria / threshold;
- optional opt-in refinement stage;
- review `instructions`, `confirmWhen`, `rejectWhen`;
- evidence packet defaults (`targetItems`, source/character caps, token budget).

The canonical flow loads a preset once, screens deterministic candidates, then passes exact retained IDs to `screen_review_start`. From that point the extension owns queueing/accounting; the preset's review policy is embedded into every packet returned by `screen_review_next`.

## Adding a preset

If an existing adapter already produces the candidate/evidence semantics you need, add only a new preset under `src/presets/` and register it. Do not clone `/screen-use` or implement a new state machine.

A use-case-specific alias prompt is optional and should stay tiny.

## Refinement

Refinement is opt-in. A large retained set does not authorize another classifier pass. If refinement is requested, it has its own preflight/approval boundary and produces the exact review target passed to `screen_review_start`.

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
