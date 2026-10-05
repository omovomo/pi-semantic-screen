# Presets

Presets own semantic policy, review vocabulary, and provider selection. 0.8 supports compiled builtin presets plus two declarative JSON forms:

- **simple** — the normal `generic-source` path: describe where candidates come from and ask one semantic question;
- **advanced** — explicit provider/classifier/review/evidence configuration for use cases that need overrides or an advanced provider.

Both forms normalize deterministically into the same internal `ScreeningPreset`. The classifier/review engine does not have a separate simple-mode execution path.

## Declarative lookup

`getPreset(id)` resolves in this order:

1. builtin preset ID;
2. `PI_SEMANTIC_SCREEN_PRESET_DIR/<id>.json`;
3. `<cwd>/.pi-semantic-screen/presets/<id>.json`;
4. shipped `presets/<id>.json`;
5. an explicit JSON path passed as the preset argument.

Malformed direct presets fail closed. Listing is best-effort and skips malformed files rather than making all valid presets unavailable.

## Simple preset — preferred

For most bounded source audits, use the smallest deterministic discovery that creates a useful candidate universe. Literal discovery is the simplest form:

```json
{
  "id": "validation-bypass",
  "source": {
    "include": "**/*",
    "find": ["disable_validation", "ALLOW_ALL"]
  },
  "question": "Can this candidate disable or bypass a required validation step?"
}
```

Use `source.match` when regex is needed. `source.include` may be one glob or an array, and the runtime scope may be a directory or a single file.

When the generic NO criterion is too conservative, the compact form may add a few bounded `dropHints` instead of replacing the full classifier contract:

```json
{
  "id": "required-config-defaults",
  "source": { "include": ["**/*.ts"], "match": ["catch"] },
  "question": "Can a required configuration failure become apparently valid default behavior?",
  "dropHints": [
    "the handler explicitly rethrows or returns an explicit failure result",
    "the handler performs only cleanup, telemetry, retry, or UI notification without substituting a valid result"
  ]
}
```

`dropHints` are classifier context, not deterministic rules. A matching phrase or shape alone never authorizes DROP; bounded evidence must still clearly establish a NO answer, and ambiguity remains `UNDECIDED`. Hints are limited to 8 entries of at most 240 characters each. Because they are normalized into `primary.criteria.false`, changing them changes the classifier-contract fingerprint and invalidates cached primary results fail-closed.

`source.match` accepts either regex strings or objects when stable IDs/labels/flags are useful:

```json
{
  "id": "silent-fallbacks",
  "source": {
    "include": ["**/*.js", "**/*.ts"],
    "exclude": ["**/*.d.ts", "**/*.min.js"],
    "match": [
      { "id": "catch-clause", "label": "catch clause", "regex": "\\bcatch\\s*(?:\\([^)]*\\))?\\s*\\{" },
      { "id": "promise-catch", "label": "Promise catch", "regex": "\\.catch\\s*\\(" }
    ]
  },
  "question": "Can this failure handler turn a meaningful failure into apparently valid, default, empty, or incomplete behavior?"
}
```

The simple form uses deterministic engine-owned defaults (currently defaults version 2):

- primary threshold `0.70`;
- generic YES/NO classifier criteria around the supplied question;
- neutral review vocabulary `CONFIRM / REJECT / INSUFFICIENT_EVIDENCE`, with the exact semantic question embedded in the review instructions;
- generic-source windows: candidate `1 before / 5 after / 3500 chars`, standard `5 / 16 / 12000`, expanded `16 / 48 / 28000`, plus bounded file/candidate limits;
- packet budget `targetItems=40`, `maxItems=60`, `maxSources=10`, `maxChars=120000`, `maxTokens=7200`.

Because normalization produces a full deterministic contract, the semantic cache fingerprints the normalized question/criteria/threshold rather than relying on hidden model-generated policy.

Optional simple overrides are narrow and explicit:

```json
{
  "id": "strict-audit",
  "source": { "include": ["**/*.ts"], "match": ["catch"] },
  "question": "Could this path hide a required failure?",
  "classifier": {
    "threshold": 0.80,
    "keepWhen": "Evidence plausibly hides the required failure.",
    "dropWhen": "Evidence clearly surfaces the failure."
  },
  "evidence": { "maxTokens": 4000 }
}
```

`label`, `description`, `dropHints`, `classifier`, `review`, and evidence-budget fields are optional. A simple preset may not mix `source/question` with advanced `provider/primary/refinement`; ambiguous mixed forms fail closed.

## Advanced preset — compatibility / escape hatch

Existing advanced declarative presets remain valid. Use the advanced form when selecting a builtin provider, overriding source windows/limits, defining refinement, or requiring precise classifier/review wording:

```json
{
  "id": "my-advanced-audit",
  "label": "My advanced audit",
  "description": "...",
  "provider": {
    "kind": "generic-source",
    "config": {
      "include": ["**/*.ts"],
      "patterns": [{ "id": "candidate", "regex": "\\bcatch\\s*\\(" }],
      "candidate": { "beforeLines": 1, "afterLines": 5, "maxChars": 3500 },
      "evidence": {
        "standard": { "beforeLines": 5, "afterLines": 16, "maxChars": 12000 },
        "expanded": { "beforeLines": 16, "afterLines": 48, "maxChars": 28000 }
      }
    }
  },
  "primary": {
    "question": "...",
    "criteria": { "true": "...", "false": "..." },
    "threshold": 0.7
  },
  "review": {
    "instructions": "...",
    "confirmWhen": "...",
    "rejectWhen": "..."
  },
  "evidence": {
    "targetItems": 40,
    "maxItems": 60,
    "maxSources": 10,
    "maxChars": 120000,
    "maxTokens": 7200
  }
}
```


Advanced review policy may also supply preset-owned terminal rejection labels:

```json
"review": {
  "instructions": "Use only bounded evidence.",
  "confirmWhen": "Confirm when the semantic question is established.",
  "rejectWhen": "Reject only when a terminal non-finding reason is established.",
  "dispositions": [
    { "id": "CONFIRM", "terminal": true, "finding": true, "description": "Question established." },
    { "id": "SAFE_VARIANT", "terminal": true, "finding": false, "description": "Domain-specific safe terminal case." },
    { "id": "INSUFFICIENT_EVIDENCE", "terminal": false, "finding": false, "description": "Need more evidence." }
  ]
}
```

Only `CONFIRM` may be a finding. `INSUFFICIENT_EVIDENCE` is the only supported non-terminal disposition. This keeps workflow semantics generic while allowing domain-specific terminal explanations.

JSON remains intentional for this milestone: it avoids a YAML/runtime dependency while the declarative contract stabilizes.

## Reusing an advanced builtin provider

Advanced declarative presets may select an existing provider:

```json
"provider": { "kind": "builtin", "id": "python-exceptions" }
```

This permits a different semantic classifier/review question over the same deterministic facts without modifying extension code.

## Semantic separation

Provider evidence should report facts such as "caught failure", "returned default", or a bounded source window. The preset/classifier/reviewer decides whether those facts satisfy the semantic question.

For `python-exceptions`, the existing narrow normalization policy remains preset-owned and unchanged.
