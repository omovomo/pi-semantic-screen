import assert from "node:assert/strict";
import test from "node:test";
import type { AdapterCandidate } from "../src/adapters/types.ts";
import type { ScreeningInput, ScreeningResult } from "../src/engine.ts";
import { getPreset } from "../src/presets/registry.ts";
import {
  PresetScreeningWorkflowManager,
  exactPresetStageInput,
  retainedIds,
  type PresetScreeningWorkflowDependencies,
} from "../src/preset-screening-workflow.ts";

const preset = getPreset("python-exceptions");
const items: AdapterCandidate[] = [
  { id: "a.py:1-2", text: "a" },
  { id: "b.py:3-4", text: "b" },
  { id: "c.py:5-6", text: "c" },
];

function result(overrides: Partial<ScreeningResult> = {}): ScreeningResult {
  return {
    status: "ok",
    model: { provider: "test", id: "classifier" },
    summary: {
      total: 3,
      kept: 1,
      dropped: 1,
      undecided: 1,
      withheld: 0,
      errors: 0,
      redactedItems: 0,
      redactionCount: 0,
    },
    kept: [{ id: "a.py:1-2", probability: 0.9 }],
    dropped: [{ id: "b.py:3-4", probability: 0.1 }],
    undecided: [{ id: "c.py:5-6", probability: 0.5 }],
    withheld: [],
    errors: [],
    ...overrides,
  };
}

function deps(run: (input: ScreeningInput, stage: "primary" | "refinement") => ScreeningResult): {
  value: PresetScreeningWorkflowDependencies;
  inputs: Array<{ input: ScreeningInput; stage: "primary" | "refinement" }>;
  reviewTargets: string[][];
} {
  const inputs: Array<{ input: ScreeningInput; stage: "primary" | "refinement" }> = [];
  const reviewTargets: string[][] = [];
  const value: PresetScreeningWorkflowDependencies = {
    async discoverCandidates(request) {
      return {
        status: "ok",
        adapter: request.preset.adapter,
        scope: request.scope,
        total: items.length,
        items,
      };
    },
    async runStage(request) {
      const input = exactPresetStageInput(request.preset, request.stage, request.items, {
        confirm: request.confirm,
        provider: request.provider,
        model: request.model,
        rescreen: request.rescreen,
      });
      inputs.push({ input, stage: request.stage });
      return { result: run(input, request.stage), reused: false };
    },
    startReview(request) {
      reviewTargets.push(request.reviewTargetIds);
      return {
        status: "ok",
        workflowId: `review-${reviewTargets.length}`,
        preset: request.preset.id,
        scope: request.scope,
        progress: {
          reviewTarget: request.reviewTargetIds.length,
          semanticallyReviewed: 0,
          evidenceSeen: 0,
          blockedEvidence: 0,
          needsExpandedEvidence: 0,
          reviewableRemaining: request.reviewTargetIds.length,
          confirmed: 0,
          unreviewed: request.reviewTargetIds.length,
          resumeAvailable: request.reviewTargetIds.length > 0,
        },
        issues: [],
      };
    },
  };
  return { value, inputs, reviewTargets };
}

test("exact preset primary input owns question criteria and threshold", () => {
  const input = exactPresetStageInput(preset, "primary", items, { confirm: true });
  assert.equal(input.question, preset.primary.question);
  assert.deepEqual(input.criteria, preset.primary.criteria);
  assert.equal(input.threshold, preset.primary.threshold);
  assert.equal(input.confirm, true);
});

test("primary manager classifies with preset contract and starts review from exact retained ids", async () => {
  const manager = new PresetScreeningWorkflowManager();
  const d = deps(() => result());
  const started = await manager.startPrimary(
    { preset, scope: "garp_cli/", confirm: true },
    d.value,
  );
  assert.equal(started.status, "ok");
  assert.equal(started.reviewStarted, true);
  assert.equal(started.primary?.retained, 2);
  assert.deepEqual(d.reviewTargets, [["a.py:1-2", "c.py:5-6"]]);
  assert.equal(d.inputs.length, 1);
  assert.equal(d.inputs[0].input.question, preset.primary.question);
  assert.deepEqual(d.inputs[0].input.criteria, preset.primary.criteria);
  assert.equal(d.inputs[0].input.threshold, 0.70);
});

test("approval-required primary never starts review or becomes canonical", async () => {
  const manager = new PresetScreeningWorkflowManager();
  let calls = 0;
  const d = deps(() => {
    calls += 1;
    return result({
      status: "approval_required",
      summary: { total: 3, kept: 0, dropped: 0, undecided: 0, withheld: 3, errors: 0, redactedItems: 0, redactionCount: 0 },
      kept: [], dropped: [], undecided: [],
      withheld: items.map((item) => ({ id: item.id, reason: "approval_required" as const })),
      errors: [], projectedCalls: 3, callLimit: 2,
    });
  });
  const first = await manager.startPrimary({ preset, scope: "garp_cli/", confirm: false }, d.value);
  assert.equal(first.status, "approval_required");
  assert.equal(first.reviewStarted, false);
  assert.equal(first.primaryRunId, undefined);
  assert.deepEqual(d.reviewTargets, []);
  const second = await manager.startPrimary({ preset, scope: "garp_cli/", confirm: true }, d.value);
  assert.equal(second.status, "approval_required");
  assert.equal(calls, 2, "failed/approval-required primary must not become canonical state");
});

test("first successful primary initialization is reused without rediscovery or reclassification", async () => {
  const manager = new PresetScreeningWorkflowManager();
  let discovers = 0;
  let screens = 0;
  const d = deps(() => { screens += 1; return result(); });
  const originalDiscover = d.value.discoverCandidates;
  d.value.discoverCandidates = async (request) => { discovers += 1; return originalDiscover(request); };
  const first = await manager.startPrimary({ preset, scope: "garp_cli/", confirm: true }, d.value);
  const second = await manager.startPrimary({ preset, scope: "garp_cli/", confirm: true }, d.value);
  assert.equal(first.status, "ok");
  assert.equal(second.status, "ok");
  assert.equal(second.reusedInitialization, true);
  assert.equal(second.workflowId, first.workflowId);
  assert.equal(discovers, 1);
  assert.equal(screens, 1);
});

test("deferred primary keeps retained candidates extension-owned for exact preset refinement", async () => {
  const manager = new PresetScreeningWorkflowManager();
  const d = deps((_input, stage) => {
    if (stage === "primary") return result();
    return {
      status: "ok",
      model: { provider: "test", id: "classifier" },
      summary: { total: 2, kept: 1, dropped: 1, undecided: 0, withheld: 0, errors: 0, redactedItems: 0, redactionCount: 0 },
      kept: [{ id: "a.py:1-2", probability: 0.95 }],
      dropped: [{ id: "c.py:5-6", probability: 0.05 }],
      undecided: [], withheld: [], errors: [],
    };
  });
  const primary = await manager.startPrimary(
    { preset, scope: "garp_cli/", confirm: true, deferReview: true },
    d.value,
  );
  assert.equal(primary.status, "ok");
  assert.equal(primary.reviewStarted, false);
  assert.ok(primary.primaryRunId);
  assert.deepEqual(d.reviewTargets, []);

  const refined = await manager.startRefinement(
    { primaryRunId: primary.primaryRunId!, confirm: true },
    d.value,
  );
  assert.equal(refined.status, "ok");
  assert.equal(refined.reviewStarted, true);
  assert.equal(d.inputs[1].stage, "refinement");
  assert.equal(d.inputs[1].input.question, preset.refinement?.question);
  assert.deepEqual(d.inputs[1].input.criteria, preset.refinement?.criteria);
  assert.equal(d.inputs[1].input.threshold, preset.refinement?.threshold);
  assert.deepEqual(d.inputs[1].input.items.map((item) => item.id), ["a.py:1-2", "c.py:5-6"]);
  assert.deepEqual(d.reviewTargets, [["a.py:1-2"]]);
  assert.equal(refined.refinement?.refinementYield, 0.5);
  assert.equal(refined.refinement?.lowYield, false);
});

test("retainedIds includes kept undecided withheld and errors and excludes dropped", () => {
  const r = result({
    summary: { total: 5, kept: 1, dropped: 1, undecided: 1, withheld: 1, errors: 1, redactedItems: 0, redactionCount: 0 },
    withheld: [{ id: "w", reason: "too_large" }],
    errors: [{ id: "e", reason: "classifier_error" }],
  });
  assert.deepEqual(retainedIds(r), ["a.py:1-2", "c.py:5-6", "w", "e"]);
});
