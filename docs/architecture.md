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
- semantic-review instructions, confirmation rule, and explicit rejection rule;
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
- emits bounded source evidence plus enclosing context, deep continuation/function-return context, and lightweight call-site evidence;
- supports `detail:"expanded"` for unresolved cases without changing candidate identity;
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
blockedEvidenceIds ⊆ evidenceSeenIds
blockedEvidenceIds ∩ reviewedIds = ∅
reviewableRemaining = reviewTargetIds - reviewedIds - blockedEvidenceIds
semanticallyReviewed = |unique reviewedIds|
unreviewed = reviewTarget - semanticallyReviewed
resumeAvailable=false when no actionable IDs remain
```

A fetch stores only the exact `pendingPacketIds` returned by `screen_evidence`; those IDs are not evidence-seen yet. Every evidence packet carries an explicit `reviewContract`. The parent must assign exactly one contract disposition per pending ID. Terminal dispositions advance both `evidenceSeenIds` and `reviewedIds`; standard-detail `INSUFFICIENT_EVIDENCE` advances only `evidenceSeenIds` and forces priority refetch with `detail:"expanded"`. If expanded evidence is still insufficient, that ID is quarantined in `blockedEvidenceIds`: it stays unreviewed and cannot become a finding, while independent targets continue. Final status is `complete` when all targets are reviewed, or `review_complete_with_blocked_evidence` when the only unresolved targets are quarantined blocked IDs.

## Why this split matters

Before 0.2.0, the Python exception workflow repeatedly generated AST/evidence scripts from a large prompt. That caused inconsistent extraction, empty packets, repeated subprocess logic, and large model context.

From 0.2.0 onward:

- prompts orchestrate;
- presets define meaning;
- adapters extract deterministically;
- `screen_batch` classifies generically.

Most future use cases should require a small preset. Only genuinely new source semantics require a new adapter.

## Single-call-per-stage orchestration

Structured adapter tools must not be invoked twice merely because the parent first previews a result and later needs the same structured data in Code Mode. Call the tool from Code Mode on first use and reuse that result. In particular, avoid `direct screen_preset -> Code Mode screen_preset` and `direct screen_evidence -> Code Mode screen_evidence`. Each evidence packet is built once, its exact IDs are stored as pending in the same execution, and its evidence is then reviewed by the parent. Distinct packets may be pipelined in one user turn.

## Evidence transport budget

`screen_evidence` applies the adapter's item/source/character bounds first, then the extension applies the preset `maxTokens` budget to the exact structured payload that Code Mode will receive. The built-in preset defaults to 7200 estimated tokens, leaving headroom below Code Mode output truncation. Trimming happens only between complete evidence items; the returned `packetIds`, `sourceCount`, and `chars` are recomputed after token trimming.

Transport integrity is fail-closed: truncation warnings, `estimatedTokens > tokenBudget`, or visible item IDs that do not exactly match `pendingPacketIds` cannot advance review accounting.

## Semantic review contract

`screen_evidence` includes `instructions`, `confirmWhen`, `rejectWhen`, a fixed disposition vocabulary, and the action for insufficient evidence. Only `CONFIRM` creates a finding. UI/display-only effects, optional enrichment, cleanup/retry/telemetry, expected normalization, explicit failure states, and paths with no demonstrated core outward effect have explicit non-finding dispositions. This keeps semantic review aligned with the preset instead of relying on unconstrained parent-model intuition.
