import assert from "node:assert/strict";
import test from "node:test";
import { ClassificationResultCache, runWithClassificationCache } from "../src/cache.ts";
import type { ScreeningInput, ScreeningResult } from "../src/engine.ts";
import { getPreset } from "../src/presets/registry.ts";
import { PresetScreeningWorkflowManager, exactPresetStageInput } from "../src/preset-screening-workflow.ts";

const identity = { provider: "test", id: "cache-probe", implementation: "probe-v1" };

function classify(input: ScreeningInput): ScreeningResult {
  return {
    status: "ok",
    model: { provider: identity.provider, id: identity.id },
    summary: {
      total: input.items.length,
      kept: input.items.length,
      dropped: 0,
      undecided: 0,
      withheld: 0,
      errors: 0,
      redactedItems: 0,
      redactionCount: 0,
    },
    kept: input.items.map((item) => ({ id: item.id, probability: 0.9 })),
    dropped: [], undecided: [], withheld: [], errors: [],
    classifierAccounting: { calls: input.items.length, usageReportedCalls: 0, complete: false },
  };
}

test("0.7.1 canonical primary rediscovers every run while classifier cache reuses candidates independently", async () => {
  const manager = new PresetScreeningWorkflowManager();
  const cache = new ClassificationResultCache();
  const preset = getPreset("js-ts-silent-fallbacks");
  let candidates = [{ id: "a", text: "alpha" }, { id: "b", text: "beta" }];
  let discovers = 0;
  let reviewSequence = 0;
  const classifierBatches: string[][] = [];

  const dependencies = {
    async discoverCandidates() {
      discovers += 1;
      return { status: "ok" as const, adapter: preset.adapter, scope: "fixture", total: candidates.length, items: candidates };
    },
    async runStage(request: {
      preset: typeof preset;
      stage: "primary" | "refinement";
      items: typeof candidates;
      confirm: boolean;
      provider?: string;
      model?: string;
      rescreen?: boolean;
    }) {
      const input = exactPresetStageInput(request.preset, request.stage, request.items, {
        confirm: request.confirm,
        provider: identity.provider,
        model: identity.id,
        rescreen: request.rescreen,
      });
      return runWithClassificationCache(input, identity, cache, async (miss) => {
        classifierBatches.push(miss.items.map((item) => item.id));
        return classify(miss);
      });
    },
    startReview(request: { reviewTargetIds: string[] }) {
      reviewSequence += 1;
      return {
        status: "ok" as const,
        workflowId: `review-${reviewSequence}`,
        preset: preset.id,
        scope: "fixture",
        progress: {
          reviewTarget: request.reviewTargetIds.length,
          semanticallyReviewed: 0,
          evidenceSeen: 0,
          blockedEvidence: 0,
          needsExpandedEvidence: 0,
          reviewableRemaining: request.reviewTargetIds.length,
          confirmed: 0,
          unreviewed: request.reviewTargetIds.length,
          standardReviewed: 0,
          standardResolved: 0,
          expandedAttempted: 0,
          expandedResolved: 0,
          expandedBlocked: 0,
          expansionRate: 0,
          expandedResolutionRate: 0,
          resumeAvailable: request.reviewTargetIds.length > 0,
        },
        issues: [],
      };
    },
  };

  const first = await manager.startPrimary({ preset, scope: "fixture", confirm: true, provider: identity.provider, model: identity.id }, dependencies);
  const second = await manager.startPrimary({ preset, scope: "fixture", confirm: true, provider: identity.provider, model: identity.id }, dependencies);
  candidates = [{ id: "a", text: "alpha" }, { id: "b", text: "beta changed" }];
  const third = await manager.startPrimary({ preset, scope: "fixture", confirm: true, provider: identity.provider, model: identity.id }, dependencies);

  assert.equal(discovers, 3);
  assert.equal(first.primary?.cacheHits, 0);
  assert.equal(first.primary?.cacheMisses, 2);
  assert.equal(second.primary?.cacheHits, 2);
  assert.equal(second.primary?.cacheMisses, 0);
  assert.equal(second.primary?.classifierCalls, 0);
  assert.equal(third.primary?.cacheHits, 1);
  assert.equal(third.primary?.cacheMisses, 1);
  assert.equal(third.primary?.classifierCalls, 1);
  assert.deepEqual(classifierBatches, [["a", "b"], ["b"]]);
  assert.notEqual(first.workflowId, second.workflowId);
  assert.notEqual(second.workflowId, third.workflowId);
});
