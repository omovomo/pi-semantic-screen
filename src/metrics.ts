import type { ClassifierUsageLike } from "./engine.ts";

export interface PrimaryEfficiencyInput {
  total: number;
  kept: number;
  dropped: number;
  undecided: number;
  withheld: number;
  errors: number;
  retained: number;
  classifierCalls: number;
  cacheHits: number;
  cacheMisses: number;
  usage?: ClassifierUsageLike;
}

export interface ScreeningEfficiencyMetrics {
  discovered: number;
  primaryEvaluated: number;
  primaryCacheHits: number;
  primaryCacheMisses: number;
  dropped: number;
  kept: number;
  undecided: number;
  retained: number;
  withheld: number;
  errors: number;
  primaryReductionRate: number;
  reviewAvoided: number;
  reviewAvoidanceRate: number;
  primaryCacheHitRate: number;
  classifierInputTokens?: number;
  classifierOutputTokens?: number;
  classifierTotalTokens?: number;
  classifierCost?: number;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

export function buildScreeningEfficiency(input: PrimaryEfficiencyInput): ScreeningEfficiencyMetrics {
  return {
    discovered: input.total,
    primaryEvaluated: input.classifierCalls,
    primaryCacheHits: input.cacheHits,
    primaryCacheMisses: input.cacheMisses,
    dropped: input.dropped,
    kept: input.kept,
    undecided: input.undecided,
    retained: input.retained,
    withheld: input.withheld,
    errors: input.errors,
    primaryReductionRate: ratio(input.dropped, input.total),
    reviewAvoided: input.total - input.retained,
    reviewAvoidanceRate: ratio(input.total - input.retained, input.total),
    primaryCacheHitRate: ratio(input.cacheHits, input.total),
    ...(input.usage
      ? {
          classifierInputTokens: input.usage.input,
          classifierOutputTokens: input.usage.output,
          classifierTotalTokens: input.usage.totalTokens,
          classifierCost: input.usage.cost.total,
        }
      : {}),
  };
}
