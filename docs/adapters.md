# Evidence providers and adapters

0.7 names the core boundary **EvidenceProvider**. The historical `ScreeningAdapter` types remain compatibility aliases, so existing advanced adapters do not need an immediate package split.

```ts
interface EvidenceProvider {
  apiVersion: 1;
  id: string;
  label: string;
  discover(request): Promise<EvidenceDiscoverResult>;
  evidence(request): Promise<EvidenceResult>;
}
```

See `src/providers/types.ts`. Compatibility exports remain in `src/adapters/types.ts`; result objects still carry the historical `adapter` wire field for backward compatibility.

## Responsibilities

A provider may:

- deterministically discover candidate IDs/text;
- return count-only discovery cheaply when possible;
- map stable IDs back to exact source evidence;
- provide bounded standard/expanded evidence;
- report parse/source/identity ambiguity as an error.

A provider must not decide whether evidence satisfies the preset's business/semantic question. It emits facts; the classifier/reviewer assigns meaning.

## Discovery

`discover({mode:"count"})` supports preflight without classifier calls. `discover({mode:"candidates"})` returns stable `{id,text}` items.

Candidate text should be compact and self-contained enough for the cheap classifier. It should not contain expensive evidence that belongs only in semantic review.

## Evidence

`evidence()` receives exact candidate IDs and returns exact `packetIds`, source count, characters, and item evidence. Returning fewer items because of configured item/source/character bounds is normal. The extension then applies the separate token budget at whole-item boundaries.

Unknown/stale IDs fail closed.

## Generic-source provider

`generic-source` is the adapter-light MVP. It is instantiated by a declarative preset and supports:

- source include/exclude globs;
- multiple trusted local regex discovery patterns;
- deterministic source location and candidate IDs;
- bounded candidate line windows;
- bounded standard/expanded evidence windows;
- hard file/file-size/candidate limits;
- fail-closed errors when an included source exceeds the configured per-file bound.

It deliberately does **not** claim AST, dataflow, caller/callee, symbol-read/write, or mutation semantics. Those facts require a provider that can establish them correctly.

The shipped `presets/js-ts-silent-fallbacks.json` demonstrates catch-clause and Promise `.catch(...)` screening without a JS-specific core adapter.

## Advanced provider registration

Builtin advanced providers are registered through `src/providers/registry.ts`. `registerEvidenceProvider()` validates API version, identity, and required capabilities at runtime; API version 1 defines the internal boundary needed for future external loading.

0.7 does not automatically import arbitrary npm/local modules. External loading remains a packaging/trust concern, not a reason to couple provider-specific semantics back into the screening engine.

## Python reference provider freeze

`python-exceptions` is the reference advanced provider and remains feature-frozen after 0.6.3 except for:

- correctness fixes;
- parser/runtime compatibility;
- boundedness/performance fixes;
- genuine generic Python-language bugs;
- fail-closed correctness bugs.

Do not add audited-application class/function names, domain-specific business semantics, project-specific enum semantics, or deeper tracing justified only by one repository.

Python 3.9+ is required only for this provider. It uses framed JSON over local stdin/stdout and no third-party Python packages.
