# Adapters

Adapters turn a source domain into two deterministic operations: candidate discovery and review evidence.

## Contract

See `src/adapters/types.ts`.

### Discovery

```ts
discover({
  scope,
  mode: "count" | "candidates"
})
```

`count` should be cheap and must not build or return rich candidate text when the adapter can avoid it. This mode exists so `screen_preflight` can enforce the classifier-call guard before a large payload is created.

`candidates` returns stable `{id,text}` items. Canonical preset flows consume them internally in `screen_primary_start`; low-level/custom callers may still pass them to `screen_batch`.

If deterministic discovery is incomplete because a source cannot be read or parsed, return `status:"error"`; do not silently omit that source.

### Evidence

```ts
evidence({
  scope,
  ids,
  maxItems,
  maxSources,
  maxChars,
  detail: "standard" | "expanded"
})
```

Return:

- `packetIds`: exact IDs actually represented by evidence;
- `items`: evidence records in the same order;
- `sourceCount` and `chars`;
- `status:"error"` on stale/unresolvable targets or source failures;
- expanded detail adds targeted data-flow hints (`tracked`, `pre_try_writes`, `post_handler_reads`), post-handler validation/control hints, core calls using tracked values, persistence/save calls, exact sentinel/default handling (including direct fallback-return origins and mutable-container suppression), bounded exact caller/constructor/downstream-consumer terminal guards, value-directed interprocedural flow, and wider bounded caller context; generic function-tail text remains a bounded fallback for IDs unresolved at standard detail.

The caller must never infer packet membership from the requested number of IDs. After adapter extraction, the extension may further trim complete items to the preset `maxTokens` transport budget and recompute exact packet metadata. This is normal bounded pagination: callers must review the returned subset and continue with the remaining IDs rather than treating `requested > packetIds.length` as an error.

## Adding an adapter

1. Create `src/adapters/<name>.ts` implementing `ScreeningAdapter`.
2. Put any bundled helper scripts beside it so git/npm packages keep them together.
3. Register the adapter in `src/adapters/registry.ts`.
4. Add tests that prove:
   - stable count/discovery;
   - stable IDs;
   - exact evidence `packetIds` under caps;
   - fail-closed source errors;
   - abort behavior if the adapter performs long-running work.
5. Add one or more presets that reference the adapter.

Do **not** add parser implementation details to a prompt template.

## Python interpreter selection

The built-in `python-exceptions` adapter needs Python 3.9+ and tries:

Windows:

1. `python`
2. `py -3`
3. `python3`

Unix-like systems:

1. `python3`
2. `python`

Override the executable path with:

```text
PI_SEMANTIC_SCREEN_PYTHON=/path/to/python
```

The adapter forces UTF-8 I/O and uses JSON over stdin/stdout. No shell is required.

## Adapter design rules

- Read-only by default.
- Deterministic for the same source snapshot and request.
- Stable IDs that can be rehydrated later.
- No classifier or LLM calls inside adapters.
- No hidden fuzzy matching that can silently change candidate identity.
- Fail closed on missing source, parser failures, or stale IDs.
- Keep rich source payloads bounded and avoid duplicating source context inside one evidence item.

## Built-in Python adapter freeze boundary

The built-in `python-exceptions` adapter is feature-frozen after 0.6.3 except for correctness, compatibility, boundedness, and parser/runtime fixes.

Its responsibility is structural Python evidence only:

- `try`/`except` discovery and stable handler identity;
- assignments, mutations, control transfer, returns, raises, and loop omission;
- exact local/caller/callee argument bindings;
- structured-result constructor/field propagation;
- sentinel/default origin and explicit consumers;
- bounded returned-object fan-out;
- persistence/core-call sinks and handler exit topology;
- fail-closed ambiguity (`unknown` / insufficient evidence) rather than domain inference.

Do not add application vocabulary or semantic rules for a particular project, product, data model, business domain, function/class name, enum value, or provider. If a proposed rule needs terms from the audited application to describe why it is valid, keep that interpretation in the preset/reviewer layer or use the application only as an external regression corpus.

New capabilities should normally be proven by a second adapter or by a generic adapter/core abstraction rather than by deepening `python-exceptions` for one codebase.
