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
      "Inspect the emitted source evidence, enclosing function context, downstream behavior, function returns, and available call sites. Mechanical syntax alone is not semantic confirmation. Absence of shown downstream evidence is not proof of no outward effect; use INSUFFICIENT_EVIDENCE when the packet cannot establish either confirmation or a terminal rejection.",
    confirmWhen:
      "Confirm only when the evidence establishes both hidden/changed failure semantics and a material caller-visible/default/incomplete core outward effect.",
    rejectWhen:
      "Reject UI/display-only stale state, logging/telemetry, cleanup, retry/reconnect, optional enrichment, expected normalization, explicit failure/unavailable states, and paths where the evidence affirmatively establishes no core outward effect. UI-only effects are not findings unless they feed back into core data/control state. Missing context is INSUFFICIENT_EVIDENCE, not NO_OUTWARD_EFFECT.",
  },
  evidence: {
    targetItems: 60,
    maxItems: 80,
    maxSources: 10,
    maxChars: 120_000,
    maxTokens: 7_200,
  },
};
