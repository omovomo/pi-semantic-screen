import type { ScreeningPreset } from "./presets/types.ts";

export const REVIEW_DISPOSITION_IDS = [
  "CONFIRM",
  "EXPLICIT_FAILURE",
  "UI_ONLY",
  "OPTIONAL_ENRICHMENT",
  "CLEANUP_RETRY_TELEMETRY",
  "EXPECTED_NORMALIZATION",
  "NO_OUTWARD_EFFECT",
  "INSUFFICIENT_EVIDENCE",
] as const;

export type ReviewDispositionId = (typeof REVIEW_DISPOSITION_IDS)[number];

export interface ReviewDispositionDefinition {
  id: ReviewDispositionId;
  terminal: boolean;
  finding: boolean;
  description: string;
}

export interface ReviewContract {
  instructions: string;
  confirmWhen: string;
  rejectWhen: string;
  dispositions: ReviewDispositionDefinition[];
  insufficientEvidenceAction: string;
}

const DISPOSITIONS: ReviewDispositionDefinition[] = [
  {
    id: "CONFIRM",
    terminal: true,
    finding: true,
    description:
      "Hidden/changed failure has a material caller-visible/default/incomplete core outward effect.",
  },
  {
    id: "EXPLICIT_FAILURE",
    terminal: true,
    finding: false,
    description: "Failure is surfaced, rethrown, explicit unavailable/error, or otherwise fail-closed.",
  },
  {
    id: "UI_ONLY",
    terminal: true,
    finding: false,
    description:
      "Display/UI-only effect with no feedback into core data/control state.",
  },
  {
    id: "OPTIONAL_ENRICHMENT",
    terminal: true,
    finding: false,
    description: "Optional enrichment whose absence cannot masquerade as core success.",
  },
  {
    id: "CLEANUP_RETRY_TELEMETRY",
    terminal: true,
    finding: false,
    description: "Best-effort cleanup, retry/reconnect, logging, metrics, or telemetry only.",
  },
  {
    id: "EXPECTED_NORMALIZATION",
    terminal: true,
    finding: false,
    description: "Contract-permitted surfaced normalization; never silent loss/default of an authoritative record/state.",
  },
  {
    id: "NO_OUTWARD_EFFECT",
    terminal: true,
    finding: false,
    description: "Evidence affirmatively establishes no core outward effect; missing context is not enough.",
  },
  {
    id: "INSUFFICIENT_EVIDENCE",
    terminal: false,
    finding: false,
    description:
      "Packet proves neither confirmation nor terminal rejection; request expanded evidence instead of guessing.",
  },
];

export function buildReviewContract(preset: ScreeningPreset): ReviewContract {
  return {
    instructions: preset.review.instructions,
    confirmWhen: preset.review.confirmWhen,
    rejectWhen: preset.review.rejectWhen,
    dispositions: DISPOSITIONS.map((entry) => ({ ...entry })),
    insufficientEvidenceAction:
      "Use INSUFFICIENT_EVIDENCE; screen_review_commit keeps it unreviewed and automatically prioritizes expanded evidence.",
  };
}
