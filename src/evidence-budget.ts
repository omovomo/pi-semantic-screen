import type { AdapterEvidenceResult } from "./adapters/types.ts";

export interface TokenBoundEvidenceResult extends AdapterEvidenceResult {
  tokenBudget: number;
  estimatedTokens: number;
}

export type TextTokenEstimator = (text: string) => number;

function rebuildResult(
  result: AdapterEvidenceResult,
  items: AdapterEvidenceResult["items"],
): AdapterEvidenceResult {
  return {
    ...result,
    packetIds: items.map((item) => item.id),
    sourceCount: new Set(items.map((item) => item.source)).size,
    chars: items.reduce((sum, item) => sum + item.evidence.length, 0),
    items,
  };
}

/**
 * Bound a successful evidence result by the estimated token cost of the exact
 * structured payload that Code Mode will receive. Character/source/item caps
 * remain secondary deterministic safety bounds inside adapters; this is the
 * transport-facing cap.
 */
export function boundEvidenceByTokens(
  result: AdapterEvidenceResult,
  maxTokens: number,
  estimate: TextTokenEstimator,
  extraStructuredFields: Record<string, unknown> = {},
): TokenBoundEvidenceResult {
  if (!Number.isFinite(maxTokens) || maxTokens < 1) {
    throw new Error("maxTokens must be a positive finite number");
  }

  if (result.status !== "ok") {
    const estimatedTokens = Math.ceil(estimate(JSON.stringify({ ...result, ...extraStructuredFields })));
    return { ...result, tokenBudget: maxTokens, estimatedTokens };
  }

  const selected: AdapterEvidenceResult["items"] = [];
  let finalResult = rebuildResult(result, selected);
  let finalTokens = Math.ceil(estimate(JSON.stringify({ ...finalResult, ...extraStructuredFields })));

  for (const item of result.items) {
    const candidateItems = [...selected, item];
    const candidate = rebuildResult(result, candidateItems);
    const candidateTokens = Math.ceil(estimate(JSON.stringify({ ...candidate, ...extraStructuredFields })));
    if (candidateTokens > maxTokens) {
      if (selected.length === 0) {
        const failure: AdapterEvidenceResult = {
          ...rebuildResult(result, []),
          status: "error",
          issues: [
            ...(result.issues ?? []),
            {
              source: item.source,
              message: `single evidence item exceeds token budget ${maxTokens}: ${item.id}`,
            },
          ],
        };
        return {
          ...failure,
          tokenBudget: maxTokens,
          estimatedTokens: Math.ceil(estimate(JSON.stringify({ ...failure, ...extraStructuredFields }))),
        };
      }
      break;
    }
    selected.push(item);
    finalResult = candidate;
    finalTokens = candidateTokens;
  }

  return {
    ...finalResult,
    tokenBudget: maxTokens,
    estimatedTokens: finalTokens,
  };
}
