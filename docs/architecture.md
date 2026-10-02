# Architecture

`pi-semantic-screen` separates four concerns so a new use case does not require a new orchestration prompt.

```text
prompt / command
      |
      v
preset registry ------------------------------+
(semantic policy)                             |
      | adapter id                            |
      v                                       |
adapter registry                              |
(deterministic source handling)               |
      |                                       |
      +--> screen_discover(count/candidates)  |
      +--> screen_evidence(packet)             |
                                              |
Code Mode generic workflow                    |
      |                                       |
      +--> screen_preflight                    |
      +--> screen_batch <----------------------+ primary/refinement policy
      +--> compact review state
      +--> semantic disposition of evidence
```

## Generic classifier engine

`screen_batch` knows only:

- stable candidate IDs;
- candidate text;
- boolean question/criteria;
- threshold/provider/model/guard options.

It does **not** know files, Python, exception handlers, callers, or project structure. Keep it that way.

`screen_preflight` implements the same deterministic call-count guard without receiving candidate text and without making classifier calls.

## Presets

A preset is semantic policy:

- public ID and description;
- adapter ID;
- primary classifier question/criteria/threshold;
- optional opt-in refinement stage;
- semantic-review instructions and confirmation rule;
- evidence packet defaults.

See `src/presets/types.ts` and `docs/presets.md`.

## Adapters

An adapter is deterministic source integration. It must implement:

```ts
interface ScreeningAdapter {
  id: string;
  label: string;
  discover(request): Promise<AdapterDiscoverResult>;
  evidence(request): Promise<AdapterEvidenceResult>;
}
```

`discover()` has a cheap `count` mode and a rich `candidates` mode. `evidence()` receives stable candidate IDs and returns the exact IDs actually represented in a bounded evidence packet.

Adapters may use bundled scripts or native TypeScript, but their behavior must be testable independently of the parent model. The parent model should never have to regenerate the adapter's parser.

## Built-in Python exceptions adapter

`python-exceptions` uses one bundled Python script (`src/adapters/python-exceptions.py`) invoked directly by the extension. It does not use PowerShell and does not ask Code Mode to generate Python.

Discovery:

- walks Python files under the requested scope;
- parses each file once per adapter invocation;
- produces one candidate per `ast.ExceptHandler`;
- includes scope, caught type, try operation, handler body, and immediate downstream context;
- fails closed when a source file cannot be decoded or parsed.

Evidence:

- resolves requested stable `path:start-end` IDs;
- reads/parses source deterministically;
- emits bounded source evidence plus enclosing context and lightweight call-site evidence;
- enforces exact `packetIds`, source-count and character caps;
- fails closed on stale/unresolvable IDs rather than pretending review coverage.

## Review state

The exact resumable state lives in Code Mode store key:

```text
semantic_screen_review_state
```

It contains compact IDs/counts/findings only. Candidate text and raw evidence are intentionally not stored.

Required invariants:

```text
retained = kept + undecided + withheld + errors
reviewedIds ⊆ evidenceSeenIds
semanticallyReviewed = |unique reviewedIds|
unreviewed = reviewTarget - semanticallyReviewed
resumeAvailable=false only when reviewedIds == reviewTargetIds
```

A commit can include only IDs from the exact previous `pendingPacketIds` returned by `screen_evidence`.

## Why this split matters

Before 0.2.0, the Python exception workflow repeatedly generated AST/evidence scripts from a large prompt. That caused inconsistent extraction, empty packets, repeated subprocess logic, and large model context.

From 0.2.0 onward:

- prompts orchestrate;
- presets define meaning;
- adapters extract deterministically;
- `screen_batch` classifies generically.

Most future use cases should require a small preset. Only genuinely new source semantics require a new adapter.
