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
      "Judge only emitted evidence. Missing downstream evidence is not proof of no outward effect; missing context is INSUFFICIENT_EVIDENCE, not NO_OUTWARD_EFFECT.",
    confirmWhen:
      "CONFIRM when hidden/changed failure materially changes core caller-visible/default/incomplete state. Proven skip of a malformed authoritative source record from a normally returned authoritative collection qualifies unless that exact omission is positively permitted/surfaced; do not require proof that no other reporting exists. Failed authoritative persisted-state read/parse returning a normal empty/default domain object likewise qualifies unless permitted/surfaced.",
    rejectWhen:
      "Reject explicit failure, UI/display-only, cleanup/retry/telemetry, optional enrichment, and permitted surfaced normalization. Rendering/formatting/table/chart/detail is UI_ONLY unless it feeds core data, persisted state, policy, screening, or execution. A proven authoritative-record skip is not INSUFFICIENT merely because separate reporting is unshown; reject only if that omission is positively surfaced/permitted. Missing context is INSUFFICIENT_EVIDENCE, not NO_OUTWARD_EFFECT.",
  },
  evidence: {
    targetItems: 60,
    maxItems: 80,
    maxSources: 10,
    maxChars: 120_000,
    maxTokens: 7_200,
  },
};
