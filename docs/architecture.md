# Architecture

`pi-semantic-screen` 0.7 is a **classifier-first semantic screening engine**. Discovery/evidence providers supply bounded facts; presets own semantic policy; the primary classifier removes cheap negatives before expensive semantic review.

```text
large candidate universe
        |
        v
deterministic provider discovery
        |
        v
PRIMARY CLASSIFIER  <---- per-candidate semantic cache
   |        |
   |        +---- DROP --------------------------> stop
   |
   +------------- KEEP / UNDECIDED / unresolved
                         |
                         v
                 semantic review
                         |
                 standard evidence
                         |
              resolved / insufficient
                         |
                  expanded evidence
                         |
                         v
                  final disposition
```

The cost model is intentionally asymmetric:

```text
C_discovery << C_primary << C_review
C_standard  << C_expanded
```

The core optimization target is therefore safe **review avoidance**, not adapter rule count or raw finding count.

## Stable ownership boundaries

### Generic core

The core owns:

- classifier execution and call guard;
- per-candidate classification cache;
- preset-owned primary/refinement execution;
- review scheduling/state;
- standard -> expanded escalation;
- token/packet budgets;
- blocked-evidence quarantine;
- exact accounting;
- efficiency metrics;
- generic semantic-stability comparison.

It does not know language-specific exception semantics, application class names, domain concepts, or project-specific business rules.

### Preset

A preset owns semantic meaning:

- candidate/source provider selection;
- primary classifier question, criteria, threshold;
- optional refinement contract;
- semantic review contract;
- evidence budgets.

0.7 adds declarative JSON presets. They may reference a builtin provider or configure the bounded `generic-source` provider. A preset can be shipped, loaded from `.pi-semantic-screen/presets/<id>.json`, from `PI_SEMANTIC_SCREEN_PRESET_DIR`, or by explicit JSON path.

### Evidence provider

The provider boundary is versioned:

```ts
interface EvidenceProvider {
  apiVersion: 1;
  id: string;
  label: string;
  discover(request): Promise<EvidenceDiscoverResult>;
  evidence(request): Promise<EvidenceResult>;
}
```

Providers report facts. They must not decide whether those facts are semantically good/bad for the current audit.

`python-exceptions` now implements exactly this boundary and remains the feature-frozen reference advanced provider. `src/adapters/types.ts` and `src/adapters/registry.ts` remain compatibility aliases.

## Declarative / adapter-light path

0.7 deliberately does **not** add a universal AST/dataflow framework. The first generic provider is `generic-source`, which gives a bounded deterministic vocabulary:

- include/exclude source globs;
- regex discovery patterns;
- stable source location + matched span;
- bounded candidate source window;
- bounded standard evidence window;
- wider bounded expanded evidence window;
- exact item/source/character caps.

This is enough to prove a second meaningful JS/TS use case (`js-ts-silent-fallbacks`) without changing extension TypeScript for that use case.

The provider does not claim AST or call-graph facts. If an audit requires exact symbol flow, callers/callees, language-specific parse trees, or structured control-flow, that remains an advanced provider capability until a small cross-language primitive is justified by multiple use cases.

## Canonical preset workflow

The canonical path remains extension-owned:

```text
screen_preset
-> screen_discover(mode=count)
-> screen_preflight
-> user approval if required
-> screen_primary_start
-> screen_review_next
-> screen_review_commit
-> ...
```

The model does not reconstruct `primary.question`, `criteria`, `threshold`, retained IDs, or review target IDs.

`screen_batch` and `screen_review_start` remain low-level compatibility APIs.

### Primary initialization

`screen_primary_start` performs candidate discovery internally, constructs the exact preset-owned classifier input, classifies only cache misses, computes:

```text
retained = kept + undecided + withheld + errors
```

and starts `ReviewWorkflowManager` unless review was explicitly deferred for refinement.

The first successful initialization for the same preset definition, scope, and resolved classifier identity is canonical for the Pi session. Changing the declarative contract or selected classifier creates a new canonical key. Approval-required/error runs never become canonical state.

### Optional refinement

`screen_primary_start(..., deferReview:true)` stores primary-retained candidates in extension state. `screen_refinement_start({primaryRunId,...})` applies the exact preset refinement contract and then starts review. Refinement remains opt-in.

## Classification cache boundary

0.7 replaces canonical whole-batch reuse with per-candidate semantic reuse.

The cache key is derived from:

```text
classifier contract fingerprint
  (question + criteria + threshold)
+
normalized candidate fingerprint
  (candidate id + normalized candidate text)
+
resolved classifier identity
  (provider + model id + classifier implementation id)
```

Only successful semantic `KEEP` / `DROP` / `UNDECIDED` outcomes are cached. `withheld` and `error` outcomes are recomputed. `rescreen:true` bypasses reuse.

The classifier model is resolved **before** canonical cache lookup, so an implicit default-model change cannot reuse a stale semantic result. Changing one candidate recomputes only that candidate; changing the contract or resolved model invalidates all affected entries fail-closed.

Review dispositions are intentionally **not** cached in 0.7. Review happens in the parent semantic reasoner, whose exact implementation/model identity and prompt context are not represented reliably enough for safe automatic reuse. Standard and expanded review need separate keys when that boundary becomes trustworthy.

## Efficiency metrics

Primary results expose first-class metrics:

```text
discovered
primaryEvaluated
primaryCacheHits
primaryCacheMisses
dropped / kept / undecided / retained
primaryReductionRate
reviewAvoidanceRate
primaryCacheHitRate
classifier input/output/total tokens (only when reported)
classifier cost (only when reported)
```

`primaryEvaluated` means actual classifier calls in the current run; cache hits are reported separately.

Review workflow progress adds:

```text
standardReviewed
standardResolved
expandedAttempted
expandedResolved
expandedBlocked
expansionRate
expandedResolutionRate
```

No review token/cost figures are fabricated because review inference is not executed by an extension-owned model call.

## Review workflow and fail-closed semantics

`ReviewWorkflowManager` preserves the 0.5/0.6 invariants:

- `screen_review_next` is idempotent while a packet is pending;
- exact packet/item identity is validated before review;
- stale/non-exact commits do not mutate state;
- standard `INSUFFICIENT_EVIDENCE` queues expanded evidence;
- expanded `INSUFFICIENT_EVIDENCE` is quarantined as blocked evidence;
- only `CONFIRM` creates a finding;
- `reviewedIds ⊆ evidenceSeenIds`;
- blocked IDs remain evidence-seen but unreviewed.

Ambiguity is never silently converted into success.

## Semantic stability

`src/stability.ts` provides a generic manifest comparator for regression runs. Given `{id, disposition}` entries it reports common candidate IDs, stable/changed disposition counts, stability ratio, and CONFIRM/BLOCKED transitions. It is intentionally a pure comparison primitive rather than a persistent database.

## Provider externalization boundary

0.7 establishes the API boundary but does not yet load arbitrary external npm/local provider modules from config. Builtins are registered in `src/providers/registry.ts`; registration validates provider API version and required capabilities at runtime. Declarative presets may instantiate `generic-source` without registry changes.

The remaining step to fully external providers is a trustworthy loader policy (module resolution, API-version validation, lifecycle, trust/security, packaging). That can be added without changing classifier/review engine contracts.

## State lifetime

Preset-screening state, review state, and classification cache are process-local and reset on Pi `session_start`. Context compaction does not erase them. A Pi process restart requires a fresh screen.
