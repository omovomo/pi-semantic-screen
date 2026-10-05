# pi-semantic-screen

Classifier-first semantic screening for Pi: deterministic discovery feeds a cheap primary classifier, and expensive semantic reasoning runs only on retained candidates.

Version **0.8.0** makes the default path genuinely universal. Compact presets use a neutral preset-owned review contract, `generic-source` remains language-agnostic text/source evidence, literal `source.find` is available for simple discovery, and classifier value is reported directly as `reviewAvoided` / `reviewAvoidanceRate`. `python-exceptions` remains a feature-frozen specialized reference provider rather than the semantic model for the core.

## Architecture at a glance

```text
large candidate universe
        |
        v
deterministic provider discovery
        |
        v
PRIMARY CLASSIFIER  <---- per-candidate cache
   |        |
   |        +---- DROP --------------------> stop
   |
   +------------- retained
                     |
                     v
             semantic review
             standard -> expanded
                     |
                     v
             final disposition
```

Use cases stay small:

- semantic policy belongs in a **preset**;
- deterministic source discovery/evidence belongs in an **evidence provider**;
- canonical preset screening contracts and retained IDs stay in extension-owned screening state;
- `screen_batch` remains the generic ad-hoc classifier primitive;
- review accounting/state ownership stays in the extension.

Do not create a new large `/screen-foo` prompt for every use case. Prefer a declarative preset. Use `generic-source` for bounded text/source evidence; only genuinely richer parse/dataflow semantics require an advanced provider.

See [Architecture](docs/architecture.md), [Evidence providers](docs/adapters.md), and [Presets](docs/presets.md).

## Requirements

- Node.js 22.19+.
- Pi with Code Mode and a configured classifier model for `screen_batch`.
- Python 3.9+ only for the built-in `python-exceptions` provider. No third-party Python packages are required.

## Install

Local package:

```text
pi install ./pi-semantic-screen
```

One-off local load:

```text
pi -e ./pi-semantic-screen
```

GitHub tag:

```text
pi install git:github.com/<owner>/pi-semantic-screen@v0.8.0
```

See [Git installation and repository setup](docs/git-install.md).

## Quick start

The normal path is a compact declarative preset. A minimal language-neutral preset can use literal discovery:

```json
{
  "id": "suspicious-config",
  "source": {
    "include": "**/*",
    "find": ["ALLOW_ALL", "disable_validation"]
  },
  "question": "Can this candidate disable or bypass a required validation step?"
}
```

Save it as `.pi-semantic-screen/presets/suspicious-config.json`, then run:

```text
/screen-use suspicious-config .
```

Use `source.match` when regex discovery is needed. `source.include` may be one glob or an array. The scope may be a directory or a single file. Add bounded `dropHints` only when the generic negative criterion is too conservative.

The primary classifier is expected to remove a meaningful portion of the candidate universe from expensive semantic review while preserving fail-closed behavior. Results expose both the absolute count `reviewAvoided` and `reviewAvoidanceRate`; audit DROP safety before tuning for higher reduction.

The specialized Python compatibility/reference path remains available:

```text
/screen-exceptions my_project/
```

The shipped `js-ts-silent-fallbacks` preset is an example of language-specific policy expressed entirely as declarative data; it does not make the engine or `generic-source` JS/TS-specific.

For guarded batches above the configured call limit, `/screen-use` stops at preflight for explicit approval. `screen_primary_start` then runs the exact preset-owned classifier contract and starts review from extension-owned retained IDs. `/screen-continue` resumes an incomplete review with zero classifier calls and zero rediscovery passes.

## Tool model

### `screen_preset`

Lists presets or returns one preset's evidence-provider selection, classifier stages, review policy, and evidence limits. Declarative presets can be resolved from project/config directories or an explicit JSON path.

### `screen_discover`

Deterministic provider discovery:

```ts
await tools.screen_discover({
  preset: "python-exceptions",
  scope: "my_project/",
  mode: "count" // or "candidates"
});
```

Count mode is for preflight and returns no rich candidate array. Candidate mode remains a low-level API; canonical preset initialization discovers rich candidates internally inside `screen_primary_start`.

### `screen_preflight`

Zero-classifier-call guard:

```ts
await tools.screen_preflight({ count: 524 });
```

Default call limit is 200. Above it, explicit user approval is required before classifier calls.

### `screen_primary_start`

Canonical preset initialization. The caller supplies only preset/scope plus guard/model options; there are no `question`, `criteria`, `threshold`, candidate-text, or `reviewTargetIds` parameters. The extension:

1. loads the preset;
2. discovers candidates internally;
3. applies the exact preset primary contract;
4. computes `kept + undecided + withheld + errors`;
5. creates the review workflow atomically.

Every `screen_primary_start` creates a fresh source snapshot: deterministic candidate discovery runs again even when preset/scope/model are unchanged. Semantic reuse happens only at the per-candidate classifier cache boundary, so unchanged candidates can be cache hits while changed/new candidates are classified. `rescreen:true` bypasses classifier reuse; it is not required to notice source changes. Use `deferReview:true` only for an explicitly requested refinement path.

### `screen_primary_manifest`

Read-only observability for a completed canonical primary run. It never reruns discovery, classification, or review. Use the opaque `primaryRunId` returned by `screen_primary_start` and optionally filter by labels:

```ts
await tools.screen_primary_manifest({
  primaryRunId,
  labels: ["DROP"],
  limit: 200,
});
```

Each item reports the candidate ID, optional provider-supplied source/line/column, primary label, keep probability, DROP/KEEP label confidence, and a deterministic threshold-based `reason`. `reason` is not model chain-of-thought or a generated semantic rationale; it only explains how the recorded probability mapped to the bucket. This is intended for DROP audits and classifier observability on real repositories.

### `screen_refinement_start`

Continues a deferred primary run using the exact preset refinement contract and extension-owned retained candidates. It has its own call guard; an `approval_required` result performs zero refinement classifier calls. On success it starts review from refinement-retained IDs and reports `refinementYield` / `lowYield`.

### `screen_batch`

Generic boolean classifier primitive for ad-hoc/low-level workflows. For probability `p` and threshold `t`:

```text
p >= t       => kept
p <= 1 - t   => dropped
otherwise    => undecided
```

Every input ID ends in exactly one bucket:

```text
kept | dropped | undecided | withheld | errors
```

Errors and aborts never become `dropped`. Successful semantic outcomes are cached per candidate for the active Pi process. Keys include the exact classifier contract, normalized candidate ID/text, and the resolved classifier model/implementation identity; a changed candidate is recomputed independently and `rescreen:true` bypasses semantic reuse.

### `screen_review_start`

Low-level compatibility API. Canonical preset flows do not call it directly; `screen_primary_start` / `screen_refinement_start` create review state internally. For custom integrations it creates the extension-owned semantic-review workflow from exact retained IDs:

```ts
await tools.screen_review_start({
  preset: "python-exceptions",
  scope: "my_project/",
  reviewTargetIds
});
```

It returns a compact `workflowId` and progress. From this point onward the model must not maintain review accounting itself.

### `screen_review_next`

Returns the current evidence packet:

```ts
await tools.screen_review_next({ workflowId });
```

Omitting `workflowId` resumes the latest review workflow in the current Pi session/process.

Properties:

- expanded-evidence IDs are prioritized automatically;
- otherwise remaining targets are selected in stable order;
- evidence is token-bounded (built-in preset: 7200 estimated tokens);
- trimming occurs only at whole-item boundaries;
- the packet carries the explicit `reviewContract`;
- repeated `screen_review_next` calls before commit return the **same** pending `packetId` and evidence rather than advancing or rebuilding it.

### `screen_review_commit`

Atomically validates dispositions for the current pending packet and advances review state:

```ts
await tools.screen_review_commit({
  workflowId,
  packetId,
  dispositions: [
    {
      id: "my_project/example.py:10-12",
      disposition: "CONFIRM",
      rationale: "The failed authoritative read becomes a normal default result."
    }
  ]
});
```

The extension validates exact ID coverage and owns all state transitions:

```text
terminal disposition        -> evidenceSeen + reviewed
standard INSUFFICIENT       -> evidenceSeen + expanded queue
expanded INSUFFICIENT       -> evidenceSeen + blocked quarantine, not reviewed
CONFIRM                     -> finding
```

Missing, duplicate, extra, or stale packet dispositions fail closed and do not advance state. For robustness, commit accepts either the object form above or the equivalent compact tuple `[id, disposition, rationale]`; both normalize to the same exact-coverage validator before any state transition.

### Low-level `screen_evidence` / `screen_review_apply`

These remain available for tests, custom integrations, and ad-hoc low-level workflows. Canonical preset workflows use `screen_primary_start` / optional `screen_refinement_start`, then `screen_review_next` / `screen_review_commit`, so semantic contracts, retained IDs, and review state all stay inside the extension.

## Screening and review state ownership

The extension keeps exact process-local preset-screening state (`primaryRunId`, canonical primary result, retained primary candidates when refinement is deferred) plus exact review state:

```text
reviewTargetIds
reviewedIds
evidenceSeenIds
needsExpandedEvidenceIds
blockedEvidence
findings
pending packet + packetId
cumulative disposition event counts
final per-target disposition counts
```

Important invariants:

```text
reviewedIds ⊆ evidenceSeenIds
blockedEvidenceIds ⊆ evidenceSeenIds
blockedEvidenceIds ∩ reviewedIds = ∅
only CONFIRM creates findings
pending packet cannot advance without an exact commit
expanded insufficient evidence blocks only that ID
```

The model never serializes preset semantic contracts, retained candidate IDs, or these review sets. This eliminates classifier-contract drift, model-generated retained-ID arithmetic, stale expanded queues, accidental duplicate packets, empty-ID fetches, and manual state-merge errors.

Screening/review state survives normal turns and host context compaction because it is owned by the extension process. **Restarting Pi clears active primary/refinement and review workflows.** Start a fresh screen after a process restart.

Terminal workflow results expose two accounting views:

- `dispositionEventCounts` counts every committed standard/expanded review decision;
- `finalDispositionCounts` counts each review target exactly once at its terminal outcome.

Thus a target that is `INSUFFICIENT_EVIDENCE` at standard detail and remains unresolved at expanded detail contributes two disposition events but one final `INSUFFICIENT_EVIDENCE` outcome. The legacy `dispositionCounts` field remains as a deprecated alias of `dispositionEventCounts`.


## Review contract

Every evidence packet includes the exact preset-owned review contract. The generic compact-preset contract is deliberately neutral:

- `CONFIRM` — bounded evidence establishes a YES answer to the preset question;
- `REJECT` — bounded evidence establishes a NO answer;
- `INSUFFICIENT_EVIDENCE` — neither conclusion is established, so expanded evidence is requested or the candidate becomes blocked after expanded review.

Advanced presets may define additional **terminal, non-finding** dispositions for their own semantic domain. `CONFIRM` remains the only finding disposition and `INSUFFICIENT_EVIDENCE` remains the only non-terminal disposition. Tool schemas and disposition accounting are dynamic; the generic core does not know names such as `UI_ONLY` or `EXPLICIT_FAILURE`.

The contract is included in the evidence transport budget rather than treated as free overhead.

For `python-exceptions`, the historical exception-specific dispositions and normalization rules remain inside that preset only. They are not defaults for other use cases.

## Built-in `python-exceptions` reference provider

Candidate identity:

```text
relative/path.py:start-end
```

Candidate/evidence data includes:

- enclosing function/class scope;
- caught exception type;
- relevant `try` operation;
- handler body;
- downstream/continuation context;
- function returns and lightweight call-site hints;
- expanded targeted data-flow hints: `tracked`, `pre_try_writes`, `post_handler_reads`;
- expanded semantic hints: `post_handler_controls`, `post_handler_calls`, `persistence_calls`;
- expanded value-directed `interprocedural_flow` with exact bindings, at most two call edges, and fail-closed `terminal=unknown` on ambiguity;
- `sentinel_handling` for exact `None`/`UNKNOWN`/empty/NaN-style fallback origins plus bounded guards/consumers;
- `structured_terminal_flow` for exact constructor/result binding into downstream consumer guards and bounded branch outcomes;
- wider bounded caller context for unresolved cases;
- bounded function-tail context as a final generic fallback.

The provider is bundled deterministic Python, not model-generated code. It fails closed on unreadable/unparseable sources and stale IDs.

## Classifier selection

Canonical preset screening (`screen_primary_start` / `screen_refinement_start`) and low-level `screen_batch` select only Pi models of type `classifier` that are available/configured.

Order:

1. explicit `provider` + `model`;
2. provider-only/model-only override;
3. `PI_SEMANTIC_SCREEN_CLASSIFIER=provider/model-id`;
4. preferred `openrouter/typesafe/jev-1.13` when available;
5. deterministic fallback among available classifier providers.

No chat-model fallback exists.

Environment variables:

```text
PI_SEMANTIC_SCREEN_CLASSIFIER=openrouter/typesafe/jev-1.13
PI_SEMANTIC_SCREEN_CALL_LIMIT=200
PI_SEMANTIC_SCREEN_CONCURRENCY=12
PI_SEMANTIC_SCREEN_PYTHON=C:\Path\To\python.exe
```

Context compaction defaults to host/Pi context management. `PI_SEMANTIC_SCREEN_COMPACT_THRESHOLD` enables extension-requested compaction only when explicitly set to a positive integer; unset or `0` defers to the host.

## Usage accounting

When every classifier call reports usage, `screen_primary_start`, `screen_refinement_start`, and low-level `screen_batch` publish exact classifier token/cost usage for calls they actually execute. If any call omits usage, accounting is marked incomplete rather than fabricated.

Process-local classification reuse reports zero new classifier calls for cache hits. Primary results also expose `discovered`, `primaryEvaluated`, cache hits/misses, reduction/review-avoidance rates, and classifier token/cost fields when the runtime reports them. Review progress exposes standard/expanded attempt/resolution metrics; review token/cost figures are not fabricated.

## Security and egress

Remote classifier egress is limited to candidate text plus semantic question/criteria after conservative redaction. In canonical preset flows those semantic fields are loaded from the local preset registry inside the extension; the model does not supply them.

Discovery, preset workflow state, evidence extraction, review-state transitions, and review commit are local. The Python provider and generic-source provider do not use the network. Active review evidence may be retained temporarily in process memory only while a packet is pending; it is dropped after commit.

See [SECURITY.md](SECURITY.md).

## Repository layout

```text
extensions/screen.ts          Pi tools and runtime integration
src/engine.ts                 generic classifier engine
src/preflight.ts              zero-call guard
src/cache.ts                  per-candidate semantic classification cache
src/evidence-budget.ts        token-bounded evidence transport
src/review-contract.ts        disposition vocabulary / preset contract
src/review-apply.ts           pure exact disposition validation
src/preset-screening-workflow.ts extension-owned primary/refinement state
src/review-workflow.ts        extension-owned review state machine
src/providers/                stable evidence-provider API + generic-source
src/adapters/                 compatibility layer + Python reference provider
src/presets/                  semantic policy + declarative preset loader
presets/                      shipped declarative use cases
src/metrics.ts                classifier-first efficiency metrics
src/stability.ts              generic cross-run semantic comparison
skills/ask/SKILL.md           generic orchestration rules
prompts/                      short user commands/aliases
test/                         unit/contract/integration tests
```

## Development

From a clean clone:

```sh
npm ci
npm run check
npm run pack:dry
```

`package-lock.json` is committed intentionally for reproducible CI/development dependencies.

See [Testing](docs/testing.md) and [CONTRIBUTING.md](CONTRIBUTING.md).
