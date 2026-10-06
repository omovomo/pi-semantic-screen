import type { ScreeningCriteria } from "../engine.ts";
import type { EvidenceProviderSpec } from "../providers/spec.ts";

export interface ScreeningStagePreset {
  question: string;
  criteria: ScreeningCriteria;
  /** Keep threshold. Retains the legacy field name for compatibility. */
  threshold: number;
  /** Optional explicit DROP threshold. Omitted means legacy symmetric 1 - threshold. */
  dropThreshold?: number;
}

export interface ReviewDispositionPreset {
  id: string;
  terminal: boolean;
  finding: boolean;
  description: string;
}

export interface ScreeningPreset {
  id: string;
  label: string;
  description: string;
  /** Compatibility/provider label retained for existing tool output and callers. */
  adapter: string;
  /** Optional provider spec. Omitted means builtin provider with id=adapter. */
  provider?: EvidenceProviderSpec;
  primary: ScreeningStagePreset;
  refinement?: ScreeningStagePreset;
  review: {
    instructions: string;
    confirmWhen: string;
    rejectWhen: string;
    dispositions?: ReviewDispositionPreset[];
  };
  evidence: {
    targetItems: number;
    maxItems: number;
    maxSources: number;
    maxChars: number;
    maxTokens: number;
  };
}
