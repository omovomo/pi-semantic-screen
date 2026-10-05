import type { ReviewDispositionPreset, ScreeningPreset } from "./presets/types.ts";

export type ReviewDispositionId = string;

export interface ReviewDispositionDefinition extends ReviewDispositionPreset {}

export interface ReviewContract {
  instructions: string;
  confirmWhen: string;
  rejectWhen: string;
  dispositions: ReviewDispositionDefinition[];
  insufficientEvidenceAction: string;
}

export const GENERIC_REVIEW_DISPOSITIONS: ReviewDispositionDefinition[] = [
  {
    id: "CONFIRM",
    terminal: true,
    finding: true,
    description: "The bounded evidence establishes that the preset semantic question is satisfied.",
  },
  {
    id: "REJECT",
    terminal: true,
    finding: false,
    description: "The bounded evidence establishes that the preset semantic question is not satisfied.",
  },
  {
    id: "INSUFFICIENT_EVIDENCE",
    terminal: false,
    finding: false,
    description: "The bounded evidence establishes neither confirmation nor rejection; request expanded evidence instead of guessing.",
  },
];

export function genericReviewContract(): ReviewContract {
  return {
    instructions: "Judge only the bounded emitted evidence. Do not infer hidden facts. Missing or ambiguous context is INSUFFICIENT_EVIDENCE.",
    confirmWhen: "Use CONFIRM only when the bounded evidence establishes that the semantic question is satisfied.",
    rejectWhen: "Use REJECT only when the bounded evidence establishes that the semantic question is not satisfied.",
    dispositions: GENERIC_REVIEW_DISPOSITIONS.map((entry) => ({ ...entry })),
    insufficientEvidenceAction: "Use INSUFFICIENT_EVIDENCE when the bounded evidence is not sufficient; expanded evidence is then prioritized.",
  };
}

function validateDispositions(dispositions: ReviewDispositionDefinition[]): void {
  if (dispositions.length < 3) throw new Error("review dispositions must contain at least three entries");
  const ids = dispositions.map((entry) => entry.id);
  if (ids.some((id) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(id))) {
    throw new Error("review disposition ids must match /^[A-Z][A-Z0-9_]{0,63}$/");
  }
  if (new Set(ids).size !== ids.length) throw new Error("review disposition ids must be unique");
  for (const required of ["CONFIRM", "INSUFFICIENT_EVIDENCE"]) {
    if (!ids.includes(required)) throw new Error(`review dispositions must include ${required}`);
  }
  const confirm = dispositions.find((entry) => entry.id === "CONFIRM")!;
  if (!confirm.terminal || !confirm.finding) throw new Error("CONFIRM must be terminal and finding=true");
  const insufficient = dispositions.find((entry) => entry.id === "INSUFFICIENT_EVIDENCE")!;
  if (insufficient.terminal || insufficient.finding) {
    throw new Error("INSUFFICIENT_EVIDENCE must be non-terminal and finding=false");
  }
  for (const entry of dispositions) {
    if (!entry.description?.trim()) throw new Error(`review disposition ${entry.id} description must be non-empty`);
    if (entry.id !== "CONFIRM" && entry.finding) {
      throw new Error(`only CONFIRM may be a finding disposition: ${entry.id}`);
    }
    if (entry.id !== "INSUFFICIENT_EVIDENCE" && !entry.terminal) {
      throw new Error(`unsupported non-terminal review disposition: ${entry.id}`);
    }
  }
  if (!dispositions.some((entry) => entry.id !== "CONFIRM" && entry.id !== "INSUFFICIENT_EVIDENCE" && entry.terminal && !entry.finding)) {
    throw new Error("review dispositions must include at least one terminal non-finding rejection");
  }
}

export function buildReviewContract(preset: ScreeningPreset): ReviewContract {
  const dispositions = (preset.review.dispositions ?? GENERIC_REVIEW_DISPOSITIONS).map((entry) => ({ ...entry }));
  validateDispositions(dispositions);
  return {
    instructions: preset.review.instructions,
    confirmWhen: preset.review.confirmWhen,
    rejectWhen: preset.review.rejectWhen,
    dispositions,
    insufficientEvidenceAction:
      "Use INSUFFICIENT_EVIDENCE when the bounded evidence is not sufficient; screen_review_commit keeps it unresolved and automatically prioritizes expanded evidence.",
  };
}
