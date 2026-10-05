# Universality boundary

`pi-semantic-screen` is a classifier-first semantic screening engine, not a language analyzer.

The generic core owns only:

- bounded deterministic candidate/evidence transport;
- classifier contracts and caching;
- KEEP / DROP / UNDECIDED screening;
- preset-owned review contracts;
- standard -> expanded escalation;
- exact workflow/accounting/budget state.

`generic-source` is text/source based. It may use globs, literal discovery, regex discovery, line windows, and explicit bounds. It must not acquire target-language parser, AST, call-graph, taint, symbol-resolution, or dataflow semantics.

Language- or domain-specific semantics belong in one of two places:

1. **preset data** when text/source evidence is sufficient;
2. a **narrow evidence provider or structural resolver capability** when a deterministic fact cannot be established by text evidence.

A structural concept can be language-neutral even when one implementation is language-specific. In that case, define the capability contract first. A missing resolver must produce `unsupported`/no fact rather than guessing. Do not embed one language implementation directly into `generic-source`.

The default compact preset review vocabulary is `CONFIRM`, `REJECT`, and `INSUFFICIENT_EVIDENCE`. Specialized terminal rejection labels are preset-owned and never become generic-core defaults.

Classifier-first value is measured by expensive review avoided while preserving fail-closed safety. Report `reviewAvoided` and `reviewAvoidanceRate`, then audit DROP safety on representative corpora. Higher reduction is not an improvement if it creates unsafe DROP.
