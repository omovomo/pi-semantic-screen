import type { ScreeningPreset } from "./types.ts";

export const pythonExceptionsPreset: ScreeningPreset = {
  id: "python-exceptions",
  label: "Python exception suppression audit",
  description: "Find Python exception handlers that may hide real failures as normal/default/incomplete behavior.",
  adapter: "python-exceptions",
  primary: {
    threshold: 0.70,
    question:
      "Can this handler hide a real operational/data/programming failure by turning it into successful, normal, empty, default, fallback, or silently incomplete behavior?",
    criteria: {
      true:
        "The failed operation matters to the normal outward contract and execution may still appear usable, successful, degraded, empty, defaulted, or incomplete without an explicit failure signal.",
      false:
        "The failure is clearly surfaced, rethrown, or fail-closed, or it is limited to best-effort cleanup, telemetry/UI, retry/reconnect, or optional enrichment that cannot masquerade as a successful core result.",
    },
  },
  refinement: {
    threshold: 0.75,
    question:
      "Does the candidate itself provide concrete evidence that this caught failure can materially corrupt, omit, misroute, misprice, persist, or otherwise change a core caller-visible result/state while execution continues without an explicit failure signal?",
    criteria: {
      true:
        "The operation, handler, and downstream evidence show a plausible core outward data/control/state effect while execution continues without an explicit failure signal.",
      false:
        "The path is expected normalization, cleanup, retry/reconnect, UI/logging/telemetry, optional enrichment, or explicit unavailable/error/fail-closed behavior.",
    },
  },
  review: {
    instructions:
      "Inspect the emitted source evidence, enclosing function context, downstream behavior, and available call sites. Mechanical syntax alone is not semantic confirmation.",
    confirmWhen:
      "Confirm only when the evidence establishes both hidden/changed failure semantics and a caller-visible/default/incomplete outward effect.",
  },
  evidence: {
    targetItems: 60,
    maxItems: 80,
    maxSources: 10,
    maxChars: 120_000,
    maxTokens: 7_200,
  },
};
