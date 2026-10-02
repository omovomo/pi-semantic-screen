# Presets

A preset is the lightweight unit for a semantic-screen use case when an existing adapter already provides the required source/evidence semantics.

## Shape

See `src/presets/types.ts`.

A preset defines:

```ts
{
  id,
  label,
  description,
  adapter,
  primary: { question, criteria, threshold },
  refinement?: { question, criteria, threshold },
  review: { instructions, confirmWhen },
  evidence: { targetItems, maxItems, maxSources, maxChars, maxTokens }
}
```

The built-in `python-exceptions` preset is in `src/presets/python-exceptions.ts`.

## Add a use case with an existing adapter

If the adapter's candidate/evidence representation is already appropriate, adding a new use case should normally require only:

1. one small preset file under `src/presets/`;
2. one registry entry in `src/presets/registry.ts`;
3. tests for the semantic policy and public preset ID;
4. optionally a tiny alias prompt for ergonomics.

Do not clone `/screen-use` or the generic review state machine.

## Refinement

Refinement is optional and opt-in. A preset can define one stricter screening stage, but `/screen-use` must not run it merely because the primary retained set is large.

If refinement runs, its extra classifier calls have their own preflight/approval boundary. The workflow reports its drop yield; low yield is diagnostic and does not authorize additional classifier cascades.

## Aliases

Alias prompts should remain very small. Example:

```text
/screen-exceptions garp_cli/
```

is only an ergonomic alias for:

```text
/screen-use python-exceptions garp_cli/
```

The alias contains no AST parser, evidence builder, batching implementation, or use-case state machine.

`maxTokens` is the primary Code Mode transport budget. `maxItems`, `maxSources`, and `maxChars` remain deterministic adapter safety caps and should not be used as a proxy for transport size.
