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
      "Evidence establishes hidden/changed failure semantics and a material caller-visible/default/incomplete core outward effect.",
  },
  {
    id: "EXPLICIT_FAILURE",
    terminal: true,
    finding: false,
    description: "The failure is surfaced, rethrown, returned as an explicit unavailable/error state, or otherwise fail-closed.",
  },
  {
    id: "UI_ONLY",
    terminal: true,
    finding: false,
    description:
      "The effect is limited to display/rendering/labels/buttons/chart refresh or other UI state and does not feed back into core data/control state.",
  },
  {
    id: "OPTIONAL_ENRICHMENT",
    terminal: true,
    finding: false,
    description: "The failed work is optional enrichment whose absence cannot masquerade as a successful core result.",
  },
  {
    id: "CLEANUP_RETRY_TELEMETRY",
    terminal: true,
    finding: false,
    description: "The handler is limited to best-effort cleanup, retry/reconnect, logging, metrics, or telemetry.",
  },
  {
    id: "EXPECTED_NORMALIZATION",
    terminal: true,
    finding: false,
    description: "The handler performs expected input/value normalization within the documented outward contract.",
  },
  {
    id: "NO_OUTWARD_EFFECT",
    terminal: true,
    finding: false,
    description: "Evidence affirmatively establishes that suppressing the failure is local/non-observable to the core outward data/control-state contract; mere absence of shown downstream context is not enough.",
  },
  {
    id: "INSUFFICIENT_EVIDENCE",
    terminal: false,
    finding: false,
    description:
      "The available packet does not establish either confirmation or a terminal rejection category; request expanded evidence instead of guessing.",
  },
];

export function buildReviewContract(preset: ScreeningPreset): ReviewContract {
  return {
    instructions: preset.review.instructions,
    confirmWhen: preset.review.confirmWhen,
    rejectWhen: preset.review.rejectWhen,
    dispositions: DISPOSITIONS.map((entry) => ({ ...entry })),
    insufficientEvidenceAction:
      "Do not add this id to reviewedIds. Add it to evidenceSeenIds, keep it pending for review coverage, and refetch it with screen_evidence detail=expanded before reviewing new standard-detail ids.",
  };
}
