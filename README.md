# pi-semantic-screen

Adapter-driven semantic screening for Pi: cheaply classify many candidates, then perform bounded deep review over deterministic evidence.

Version **0.5.3** keeps the proven 0.5.x primary/review state machine and focuses on review robustness and evidence efficiency. `screen_review_commit` now tolerates compact tuple-form dispositions as well as objects, the review contract is smaller but still self-contained, and expanded Python evidence surfaces targeted validation/core-call/persistence/caller context before falling back to generic function-tail text.

## Architecture at a glance

```text
screen_preset / screen_preflight / screen_batch   generic screening
                    |
                    v
screen_review_start                               create extension-owned workflow
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
- generic screening stays in `screen_batch`;
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
pi install git:github.com/<owner>/pi-semantic-screen@v0.5.3
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

For guarded batches above the configured call limit, `/screen-use` stops at preflight for explicit approval. After approval the canonical primary `screen_batch` is invoked with `confirm:true`; if it still returns a non-`ok` status, review is not started.

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

Count mode is for preflight and returns no rich candidate array. Candidate mode returns stable `{id,text}` items for `screen_batch`.

### `screen_preflight`

Zero-classifier-call guard:

```ts
await tools.screen_preflight({ count: 524 });
```

Default call limit is 200. Above it, explicit user approval is required before classifier calls.

### `screen_batch`

Generic boolean classifier primitive. For probability `p` and threshold `t`:

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

Creates the extension-owned semantic-review workflow from the exact retained IDs:

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

These remain available for tests, custom integrations, and ad-hoc low-level workflows. Canonical preset workflows use `screen_review_start` / `screen_review_next` / `screen_review_commit` so review state ownership stays inside the extension.

## Review state ownership

The extension keeps exact process-local review state:

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

The model never serializes or merges these sets. This eliminates model-generated set arithmetic, stale expanded queues, accidental duplicate packets, empty-ID fetches, and manual state-merge errors.

Review state survives normal turns and host context compaction because it is owned by the extension process. **Restarting Pi clears active review workflows.** Start a fresh screen after a process restart.

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
- wider bounded caller context for unresolved cases;
- bounded function-tail context as a final generic fallback.

The adapter is bundled deterministic Python, not model-generated code. It fails closed on unreadable/unparseable sources and stale IDs.

## Classifier selection

`screen_batch` selects only Pi models of type `classifier` that are available/configured.

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

When every classifier call reports usage, `screen_batch` aggregates exact classifier token/cost usage and publishes it as tool-result usage. If any call omits usage, accounting is marked incomplete rather than fabricated.

Process-local result reuse reports zero new classifier usage.

## Security and egress

Remote classifier egress is limited to explicit `screen_batch` item text, question, and criteria after conservative redaction.

Discovery, evidence extraction, review-state transitions, and review commit are local. The Python adapter does not use the network. Active review evidence may be retained temporarily in process memory only while a packet is pending; it is dropped after commit.

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
