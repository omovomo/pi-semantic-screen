# Presets

Presets own semantic policy and provider selection. 0.7.1 supports compiled builtin presets plus two declarative JSON forms:

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

For most bounded source audits, this is sufficient:

```json
{
  "id": "required-config-defaults",
  "source": {
    "include": ["**/*.ts"],
    "match": ["\\bcatch\\s*\\(", "\\.catch\\s*\\("]
  },
  "question": "Can a required configuration failure become apparently valid default behavior?"
}
```

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

The simple form uses deterministic engine-owned defaults (currently defaults version 1):

- primary threshold `0.70`;
- generic YES/NO classifier criteria around the supplied question;
- fail-closed review instructions that embed the exact semantic question and require `INSUFFICIENT_EVIDENCE` for missing/ambiguous context;
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

`label`, `description`, `classifier`, `review`, and evidence-budget fields are optional. A simple preset may not mix `source/question` with advanced `provider/primary/refinement`; ambiguous mixed forms fail closed.

## Advanced preset — compatibility / escape hatch

Existing 0.7.0 declarative presets remain valid. Use the advanced form when selecting a builtin provider, overriding source windows/limits, defining refinement, or requiring precise classifier/review wording:

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
