# pi-semantic-screen

Adapter-driven semantic screening for Pi Code Mode: cheaply classify many candidates, then perform bounded resumable deep review over deterministic evidence.

Version **0.2.0** replaces use-case-specific orchestration with a generic engine + adapters + presets.

## Why 0.2.0

Early releases proved the classifier path but also exposed a scaling problem: a rich `/screen-exceptions` prompt repeatedly asked the parent model to generate Python AST/evidence scripts. That made extraction inconsistent and expensive.

0.2.0 separates concerns:

```text
screen_batch / screen_preflight   generic classifier engine
screen_preset                     semantic policy
screen_discover                   deterministic adapter discovery
screen_evidence                   deterministic bounded review evidence
/screen-use                       generic workflow
/screen-exceptions                short alias only
```

For a future use case, **do not create another large prompt**. If an existing adapter fits, add a small preset. Only new source semantics require a new adapter.

See [Architecture](docs/architecture.md), [Adapters](docs/adapters.md), and [Presets](docs/presets.md).

## Requirements

- Node.js 22.19+ (same baseline as current Pi).
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

GitHub release tag:

```text
pi install git:github.com/<owner>/pi-semantic-screen@v0.2.0
```

Pi packages are designed to distribute extensions, skills, and prompt templates together, including installation from git/npm/local sources. Host Pi packages are declared as peer dependencies rather than bundled runtime dependencies.

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

Optional explicit refinement stage:

```text
/screen-use python-exceptions garp_cli/ --refine
```

Continue an incomplete semantic review without rediscovery or classifier calls:

```text
/screen-continue
```

List/load presets from Code Mode with `screen_preset`. The first built-in preset is `python-exceptions`.

## Tool model

### `screen_preset`

Lists installed presets or returns one preset's adapter, classifier stages, review policy, and evidence limits.

### `screen_discover`

Runs deterministic adapter discovery:

```ts
await tools.screen_discover({
  preset: "python-exceptions",
  scope: "garp_cli/",
  mode: "count" // or "candidates"
});
```

Count mode is intended for preflight and returns no rich candidate array. Candidates mode returns stable `{id,text}` items for `screen_batch`.

### `screen_preflight`

Zero-call guard:

```ts
await tools.screen_preflight({ count: 524 });
```

Default call limit is 200. Above it, the workflow must obtain explicit user approval before classifier calls.

### `screen_batch`

Generic boolean classifier primitive:

```ts
await tools.screen_batch({
  items: [{ id: "stable-id", text: "candidate evidence" }],
  question: "Should this candidate be retained?",
  criteria: {
    true: "Retain for deeper review.",
    false: "Safe to exclude from deeper review."
  },
  threshold: 0.70
});
```

For bool probability `p` and threshold `t`:

```text
p >= t       => kept
p <= 1 - t   => dropped
otherwise    => undecided
```

Every input ID ends in exactly one bucket:

```text
kept | dropped | undecided | withheld | errors
```

Errors and aborts never become `dropped`.

Successful identical runs are reused from a small process-local in-memory cache. `rescreen:true` is reserved for an explicit fresh-run request.

### `screen_evidence`

Produces a deterministic bounded review packet from stable IDs:

```ts
await tools.screen_evidence({
  preset: "python-exceptions",
  scope: "garp_cli/",
  ids: remainingIds,
  maxItems: 80,
  maxSources: 10,
  maxChars: 40000
});
```

The returned `packetIds` are authoritative. Review accounting must never assume that all requested IDs fit the packet.

## Built-in `python-exceptions` adapter

Candidate identity:

```text
relative/path.py:start-end
```

Each candidate includes:

- enclosing function/class scope;
- caught exception type;
- relevant `try` operation;
- handler body;
- immediate downstream context.

Review evidence additionally includes bounded enclosing source and lightweight call-site evidence. The adapter fails closed on unreadable/unparseable Python sources instead of silently dropping them.

The adapter is bundled code, not model-generated Python, and is invoked directly without PowerShell.

## Generic review accounting

Exact resumable state is stored under:

```text
semantic_screen_review_state
```

Important invariants:

```text
retained = kept + undecided + withheld + errors
reviewedIds ⊆ evidenceSeenIds
semanticallyReviewed = |unique reviewedIds|
unreviewed = reviewTarget - semanticallyReviewed
resumeAvailable=false only when reviewedIds == reviewTargetIds
```

Candidate text and raw evidence are not stored in the resumable state.

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

Context compaction defaults to the host/Pi context manager. `PI_SEMANTIC_SCREEN_COMPACT_THRESHOLD` only enables extension-requested compaction when explicitly set to a positive integer; unset or `0` defers to the host.

## Classifier usage accounting

When the classifier runtime reports usage for every call, `screen_batch` aggregates exact classifier token/cost usage and exposes it as tool-result usage. If any call lacks usage, the result marks accounting incomplete rather than inventing totals.

Process-local result reuse reports zero new classifier usage.

## Security and egress

Remote classifier egress is limited to the explicit `screen_batch` item text, question, and criteria after conservative redaction. Recognized bearer/API token forms, common vendor token prefixes, private-key blocks, and similar patterns are replaced before classification.

`screen_discover` and `screen_evidence` are local read-only adapter operations. The Python adapter does not use the network.

See [SECURITY.md](SECURITY.md).

## Repository layout

```text
extensions/screen.ts              Pi tools + classifier integration
src/engine.ts                     generic classifier engine
src/adapters/                     deterministic source integrations
src/presets/                      semantic policy definitions
skills/ask/SKILL.md               generic workflow instructions
prompts/screen-use.md             generic preset command
prompts/screen-exceptions.md      short alias
prompts/screen-continue.md        resumable review
prompts/screen.md                 ad-hoc fallback
docs/                             architecture/development docs
test/                             offline contract/integration tests
```

## Adding a use case

If an adapter already represents the right candidates/evidence:

```text
new preset
+ registry entry
+ tests
```

If the source semantics are new:

```text
new adapter
+ preset
+ tests
```

A new use case should **not** require copying the generic workflow into another prompt. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

```sh
npm install --ignore-scripts
npm run check
npm run pack:dry
```

With a matching Pi host:

```sh
npm run typecheck
npm run test:codemode
```

See [Testing](docs/testing.md).

## Pi API / packaging notes

The package follows Pi's current package model: extensions/skills/prompts can be bundled in one package and installed from local, npm, or git sources. Runtime Pi packages supplied by the host are peer dependencies.

The classifier integration uses an extension-owned lazy `ModelRuntime` because classifier operations are provided by the model runtime rather than the extension `modelRegistry` compatibility facade. The runtime is refreshed without model-network discovery before selection.

## License

Licensed under the MIT License. See `LICENSE`.
