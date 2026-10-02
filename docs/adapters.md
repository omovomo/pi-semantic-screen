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

`candidates` returns stable `{id,text}` items suitable for `screen_batch`.

If deterministic discovery is incomplete because a source cannot be read or parsed, return `status:"error"`; do not silently omit that source.

### Evidence

```ts
evidence({
  scope,
  ids,
  maxItems,
  maxSources,
  maxChars
})
```

Return:

- `packetIds`: exact IDs actually represented by evidence;
- `items`: evidence records in the same order;
- `sourceCount` and `chars`;
- `status:"error"` on stale/unresolvable targets or source failures.

The caller must never infer packet membership from the requested number of IDs.

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
- Keep rich source payloads bounded.
