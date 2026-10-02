import type { ScreeningCriteria } from "../engine.ts";

export interface ScreeningStagePreset {
  question: string;
  criteria: ScreeningCriteria;
  threshold: number;
}

export interface ScreeningPreset {
  id: string;
  label: string;
  description: string;
  adapter: string;
  primary: ScreeningStagePreset;
  refinement?: ScreeningStagePreset;
  review: {
    instructions: string;
    confirmWhen: string;
    rejectWhen: string;
  };
  evidence: {
    targetItems: number;
    maxItems: number;
    maxSources: number;
    maxChars: number;
    maxTokens: number;
  };
}
