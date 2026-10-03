# pi-semantic-screen

Adapter-driven semantic screening for Pi: cheaply classify many candidates, then perform bounded deep review over deterministic evidence.

Version **0.6.2** keeps the extension-owned preset screening architecture from 0.6.0 and improves expanded Python evidence. It also fixes expanded evidence for module/class-level exception handlers by initializing and emitting `handler_control_flow` independently of function-level data-flow analysis. Small exact returned-object fan-out now preserves consumer shapes even when decision logic is delegated, direct forms such as `evaluate(build_input())` are resolved structurally, and `handler_control_flow` summarizes complete handler branch/exit topology plus the common fallthrough target. Review dispositions, canonical primary ownership, the two generic call-edge bound, and the 7200-token packet budget remain unchanged.

## Architecture at a glance

```text
screen_preset + count discovery + screen_preflight
                    |
                    v
screen_primary_start                              exact preset primary contract
      |                                           retained IDs owned by extension
      +-- optional defer --> screen_refinement_start
                    |
                    v
extension-owned ReviewWorkflowManager
                    |
                    v
screen_review_next  --> evidence + reviewContract
                    |
                    v
parent model       --> {id, disposition, rationale} × N
                    |
                    v
screen_review_commit                              atomic state transition
                    |
                    +--> next packet / complete / complete-with-blocked
```

Use cases stay small:

- semantic policy belongs in a **preset**;
- deterministic source discovery/evidence belongs in an **adapter**;
- canonical preset screening contracts and retained IDs stay in extension-owned screening state;
- `screen_batch` remains the generic ad-hoc classifier primitive;
- review accounting/state ownership stays in the extension.

Do not create a new large `/screen-foo` prompt for every use case. If an existing adapter fits, add a preset. Only genuinely new source semantics require a new adapter.

See [Architecture](docs/architecture.md), [Adapters](docs/adapters.md), and [Presets](docs/presets.md).

## Requirements

- Node.js 22.19+.
- Pi with Code Mode and a configured classifier model for `screen_batch`.
- Python 3.9+ only for the built-in `python-exceptions` adapter. No third-party Python packages are required.

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
pi install git:github.com/<owner>/pi-semantic-screen@v0.6.2
```

See [Git installation and repository setup](docs/git-install.md).

## Quick start

Built-in Python exception audit:

```text
/screen-exceptions garp_cli/
```

Equivalent generic command:

```text
/screen-use python-exceptions garp_cli/
```

Optional explicit refinement:

```text
/screen-use python-exceptions garp_cli/ --refine
```

For guarded batches above the configured call limit, `/screen-use` stops at preflight for explicit approval. After approval `screen_primary_start` runs the exact preset-owned primary contract with `confirm:true`; the model never reconstructs classifier semantics or retained IDs. If primary screening is non-`ok`, review is not started.

Continue an incomplete semantic review:

```text
/screen-continue
```

`/screen-continue` makes zero classifier calls and zero rediscovery passes. It resumes the latest extension-owned review workflow in the current Pi process.

## Tool model

### `screen_preset`

Lists presets or returns one preset's adapter, classifier stages, review policy, and evidence limits.

### `screen_discover`

Deterministic adapter discovery:

```ts
await tools.screen_discover({
  preset: "python-exceptions",
  scope: "garp_cli/",
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

The first successful `preset+scope` initialization is canonical for the active Pi session unless `rescreen:true` is explicit. Use `deferReview:true` only for an explicitly requested refinement path.

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

Errors and aborts never become `dropped`. Successful identical runs are reused from a small process-local result cache; `rescreen:true` explicitly bypasses reuse.

### `screen_review_start`

Low-level compatibility API. Canonical preset flows do not call it directly; `screen_primary_start` / `screen_refinement_start` create review state internally. For custom integrations it creates the extension-owned semantic-review workflow from exact retained IDs:

```ts
await tools.screen_review_start({
  preset: "python-exceptions",
  scope: "garp_cli/",
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
      id: "garp_cli/example.py:10-12",
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
cumulative disposition counts
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

## Review contract

Every evidence packet includes a compact, self-contained review contract plus a fixed disposition vocabulary. The contract is included in the 7200-token transport budget rather than treated as free overhead.


- `CONFIRM`
- `EXPLICIT_FAILURE`
- `UI_ONLY`
- `OPTIONAL_ENRICHMENT`
- `CLEANUP_RETRY_TELEMETRY`
- `EXPECTED_NORMALIZATION`
- `NO_OUTWARD_EFFECT`
- `INSUFFICIENT_EVIDENCE`

`NO_OUTWARD_EFFECT` requires affirmative evidence of locality; missing context is `INSUFFICIENT_EVIDENCE`.

For `python-exceptions`, normalization is intentionally narrow:

- silently dropping a malformed authoritative lot/transaction/record from a normal returned core object is **not** expected normalization unless omission is explicitly allowed and surfaced;
- failed read/parse of authoritative persisted domain state followed by returning an empty/default domain object as normal usable state is **CONFIRM**, not `EXPECTED_NORMALIZATION`, unless that defaulting is explicitly part of the outward contract and surfaced.

## Built-in `python-exceptions` adapter

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
- `policy_terminal_flow` for exact constructor/result binding into policy/evaluator guards and bounded branch outcomes;
- wider bounded caller context for unresolved cases;
- bounded function-tail context as a final generic fallback.

The adapter is bundled deterministic Python, not model-generated code. It fails closed on unreadable/unparseable sources and stale IDs.

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

Process-local result reuse reports zero new classifier usage.

## Security and egress

Remote classifier egress is limited to candidate text plus semantic question/criteria after conservative redaction. In canonical preset flows those semantic fields are loaded from the local preset registry inside the extension; the model does not supply them.

Discovery, preset workflow state, evidence extraction, review-state transitions, and review commit are local. The Python adapter does not use the network. Active review evidence may be retained temporarily in process memory only while a packet is pending; it is dropped after commit.

See [SECURITY.md](SECURITY.md).

## Repository layout

```text
extensions/screen.ts          Pi tools and runtime integration
src/engine.ts                 generic classifier engine
src/preflight.ts              zero-call guard
src/cache.ts                  process-local screening result cache
src/evidence-budget.ts        token-bounded evidence transport
src/review-contract.ts        disposition vocabulary / preset contract
src/review-apply.ts           pure exact disposition validation
src/preset-screening-workflow.ts extension-owned primary/refinement state
src/review-workflow.ts        extension-owned review state machine
src/adapters/                 deterministic source adapters
src/presets/                  semantic policy presets
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
