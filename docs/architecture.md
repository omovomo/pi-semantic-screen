# Architecture

`pi-semantic-screen` separates classifier screening, semantic policy, deterministic source integration, and review-state ownership.

```text
prompt / command
      |
      +--> preset registry ------------------------------+
      |     semantic policy                              |
      |                                                  |
      +--> adapter registry                              |
      |     deterministic discovery/evidence             |
      |                                                  |
      +--> screen_preflight                              |
      +--> screen_batch <--------------------------------+ primary/refinement
      |
      +--> screen_review_start(reviewTargetIds)
              |
              v
        extension-owned ReviewWorkflowManager
              |
              +--> screen_review_next
              |      -> adapter evidence
              |      -> token bound
              |      -> reviewContract
              |      -> exact pending packet
              |
              +--> screen_review_commit
                     -> exact coverage validation
                     -> reviewed/evidenceSeen
                     -> expanded queue
                     -> blocked quarantine
                     -> findings
                     -> terminal status
```

## Generic classifier engine

`screen_batch` knows only stable candidate IDs, candidate text, boolean criteria, threshold/model options, and the deterministic call guard. It does not know files, Python, exceptions, callers, or review workflow state.

`screen_preflight` applies the same projected-call guard without candidate text and with zero classifier calls.

## Presets

A preset defines semantic policy:

- public ID/description;
- adapter ID;
- primary classifier stage;
- optional opt-in refinement stage;
- semantic review instructions / confirm / reject policy;
- evidence packet defaults.

A preset does not implement traversal, parsing, evidence extraction, or review-state bookkeeping.

## Value-directed expanded evidence

The built-in Python adapter may enrich only `detail:"expanded"` packets with deterministic value-directed evidence. It traces concrete affected values through local reads/calls/returns and at most two exact call edges, treats direct fallback returns as synthetic affected values when one exact caller binding exists, suppresses false empty-container sentinels when the caught path can mutate them, and can connect exact policy/data constructors to evaluator guards with explicit bounded outcomes. Ambiguous bindings are not guessed and remain `unknown`. These extractors are evidence-only: they do not decide whether a fallback is safe or material. Review state and semantic disposition policy are unchanged.

## Adapters

An adapter implements deterministic source integration:

```ts
interface ScreeningAdapter {
  id: string;
  label: string;
  discover(request): Promise<AdapterDiscoverResult>;
  evidence(request): Promise<AdapterEvidenceResult>;
}
```

`discover()` exposes cheap `count` and rich `candidates` modes. `evidence()` receives stable IDs and returns exact represented IDs plus bounded evidence. Adapters fail closed on source/identity errors.

## Extension-owned review workflow

0.5.x moves the review state machine out of prompts/Code Mode and into `ReviewWorkflowManager`.

### Start

After canonical screening/refinement, `screen_review_start` receives exact `reviewTargetIds` and creates an opaque process-local `workflowId`.

### Next

`screen_review_next` selects work deterministically:

1. unresolved standard items needing expanded evidence;
2. otherwise stable-order unreviewed/unblocked standard targets.

The manager invokes the preset adapter, applies the token budget, validates exact packet/item identity, assigns an opaque `packetId`, and stores the packet as pending.

A second `screen_review_next` before commit returns the same pending packet. It does not rebuild evidence or advance the queue.

Pi sends tool `content` to the parent model while `structuredContent` is for programmatic callers. `screen_review_next` therefore serializes the bounded packet/result into model-facing `content` as well as exposing typed `structuredContent`; `screen_review_commit` does the same for progress/findings.

### Commit

`screen_review_commit` accepts only `workflowId`, `packetId`, and semantic dispositions. Dispositions may be objects or compact `[id, disposition, rationale]` tuples; the workflow normalizes both forms before validating the exact current pending packet and delegating exact coverage to the pure `applyReviewDispositions()` function.

State mutation is atomic only after validation succeeds:

```text
standard INSUFFICIENT_EVIDENCE
  -> evidenceSeen
  -> needsExpanded queue
  -> not reviewed

expanded INSUFFICIENT_EVIDENCE
  -> evidenceSeen
  -> blocked quarantine
  -> not reviewed

terminal non-finding
  -> evidenceSeen + reviewed

CONFIRM
  -> evidenceSeen + reviewed + finding
```

A stale packet ID, missing disposition, duplicate disposition, or extra disposition leaves workflow state unchanged.

### Terminal status

When all targets are either reviewed or blocked:

```text
complete
```

or:

```text
review_complete_with_blocked_evidence
```

Blocked IDs remain honestly unreviewed.

## State lifetime

Review workflow state is process-local. It survives model context compaction and ordinary user turns because it is not stored in model context. It is reset on Pi `session_start` / process restart.

This is deliberate for 0.5.x: no raw evidence or mutable accounting snapshot is serialized by the model. A future persistent workflow store could be added behind the same opaque workflow API without returning ownership to prompts.

## Evidence transport

The adapter applies source/item/character safety caps, then the extension applies the preset `maxTokens` budget to the exact structured evidence payload including `reviewContract` overhead.

Trimming occurs only between complete items. The manager validates that returned `packetIds` exactly match evidence item IDs and that all returned IDs were requested before making the packet pending.

A smaller returned subset than the internal requested set is normal. Requested size is not review coverage.

## Semantic review contract

Each packet carries `instructions`, `confirmWhen`, `rejectWhen`, and the fixed disposition vocabulary. The parent model performs only this semantic step. It never chooses queue order or edits review accounting.

`NO_OUTWARD_EFFECT` requires affirmative evidence. Missing context is `INSUFFICIENT_EVIDENCE`.

For authoritative source data, silently dropping malformed records or replacing failed authoritative persisted-state loading with a normal empty/default domain object is not `EXPECTED_NORMALIZATION` unless that behavior is explicitly permitted and surfaced.

## Low-level compatibility APIs

`screen_evidence` and `screen_review_apply` remain public low-level tools for tests/custom integrations. Canonical preset workflows use the stateful review trio:

```text
screen_review_start
screen_review_next
screen_review_commit
```

This keeps state ownership in one layer while preserving reusable primitives.
