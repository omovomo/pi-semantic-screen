# Presets

Presets own semantic policy and provider selection. 0.7 supports both compiled builtin presets and declarative JSON presets.

A preset defines:

- ID, label, description;
- evidence provider selection/configuration;
- primary classifier question, criteria, threshold;
- optional refinement classifier stage;
- review instructions / confirm / reject policy;
- evidence packet budgets.

It does not own mutable review state or classifier orchestration.

## Declarative lookup

`getPreset(id)` resolves in this order:

1. builtin preset ID;
2. `PI_SEMANTIC_SCREEN_PRESET_DIR/<id>.json`;
3. `<cwd>/.pi-semantic-screen/presets/<id>.json`;
4. shipped `presets/<id>.json`;
5. an explicit JSON path passed as the preset argument.

Malformed direct presets fail closed. Listing is best-effort and skips malformed files rather than making all valid presets unavailable.

## Minimal JSON model

```json
{
  "id": "my-audit",
  "label": "My audit",
  "description": "...",
  "provider": {
    "kind": "generic-source",
    "config": {
      "include": ["**/*.ts"],
      "patterns": [
        { "id": "candidate", "regex": "\\bcatch\\s*\\(" }
      ],
      "candidate": { "beforeLines": 1, "afterLines": 4, "maxChars": 3000 },
      "evidence": {
        "standard": { "beforeLines": 4, "afterLines": 12, "maxChars": 10000 },
        "expanded": { "beforeLines": 12, "afterLines": 36, "maxChars": 24000 }
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

JSON is intentional for the MVP: it avoids adding a YAML parser/runtime dependency before the declarative model stabilizes.

## Reusing an advanced builtin provider

Declarative presets may also select an existing provider:

```json
"provider": { "kind": "builtin", "id": "python-exceptions" }
```

This permits a different semantic classifier/review question over the same deterministic facts without modifying extension code.

## Semantic separation

Provider evidence should say things such as "caught failure", "returned default", "source window contains return {}". The preset/reviewer decides whether that behavior is a finding for the current semantic question.

For `python-exceptions`, the existing narrow normalization policy remains preset-owned and unchanged.
