import type { AdapterCandidate, AdapterDiscoverResult } from "./adapters/types.ts";
import type { ClassifierUsageLike, ScreeningInput, ScreeningResult } from "./engine.ts";
import { buildScreeningEfficiency, type ScreeningEfficiencyMetrics } from "./metrics.ts";
import type { ScreeningPreset, ScreeningStagePreset } from "./presets/types.ts";
import type { ReviewWorkflowProgress, ReviewWorkflowStartResult } from "./review-workflow.ts";

export interface ScreeningStageSummary {
  total: number;
  kept: number;
  dropped: number;
  undecided: number;
  withheld: number;
  errors: number;
  retained: number;
  model?: { provider: string; id: string };
  reusedScreening: boolean;
  classifierCalls: number;
  cacheHits: number;
  cacheMisses: number;
  classifierUsage?: ClassifierUsageLike;
}

export interface PrimaryScreeningStartResult {
  status: "ok" | "approval_required" | "error";
  preset: string;
  scope: string;
  primaryRunId?: string;
  primary?: ScreeningStageSummary;
  efficiency?: ScreeningEfficiencyMetrics;
  reviewStarted: boolean;
  workflowId?: string;
  progress?: ReviewWorkflowProgress;
  refinementAvailable: boolean;
  refinementDeferred: boolean;
  reusedInitialization: boolean;
  projectedCalls?: number;
  callLimit?: number;
  issues: string[];
}

export interface RefinementScreeningStartResult {
  status: "ok" | "approval_required" | "error";
  preset?: string;
  scope?: string;
  primaryRunId?: string;
  primary?: ScreeningStageSummary;
  efficiency?: ScreeningEfficiencyMetrics;
  refinement?: ScreeningStageSummary & { refinementYield: number; lowYield: boolean };
  reviewStarted: boolean;
  workflowId?: string;
  progress?: ReviewWorkflowProgress;
  reusedInitialization: boolean;
  projectedCalls?: number;
  callLimit?: number;
  issues: string[];
}

export interface PresetScreeningWorkflowDependencies {
  discoverCandidates(request: {
    preset: ScreeningPreset;
    scope: string;
    signal?: AbortSignal;
  }): Promise<AdapterDiscoverResult>;
  runStage(request: {
    preset: ScreeningPreset;
    stage: "primary" | "refinement";
    items: AdapterCandidate[];
    confirm: boolean;
    provider?: string;
    model?: string;
    rescreen?: boolean;
    signal?: AbortSignal;
  }): Promise<{ result: ScreeningResult; reused: boolean; cacheHits?: number; cacheMisses?: number }>;
  startReview(request: {
    preset: ScreeningPreset;
    scope: string;
    reviewTargetIds: string[];
  }): ReviewWorkflowStartResult;
}

interface PrimaryRunState {
  id: string;
  key: string;
  preset: ScreeningPreset;
  scope: string;
  provider?: string;
  model?: string;
  retainedItems: AdapterCandidate[];
  primary: ScreeningStageSummary;
  review?: ReviewWorkflowStartResult;
  refinement?: ScreeningStageSummary & { refinementYield: number; lowYield: boolean };
}

function stageInput(
  stage: ScreeningStagePreset,
  items: AdapterCandidate[],
  request: {
    confirm: boolean;
    provider?: string;
    model?: string;
    rescreen?: boolean;
  },
): ScreeningInput {
  return {
    items,
    question: stage.question,
    criteria: stage.criteria,
    threshold: stage.threshold,
    confirm: request.confirm,
    ...(request.provider ? { provider: request.provider } : {}),
    ...(request.model ? { model: request.model } : {}),
    ...(request.rescreen === true ? { rescreen: true } : {}),
  };
}

export function exactPresetStageInput(
  preset: ScreeningPreset,
  stage: "primary" | "refinement",
  items: AdapterCandidate[],
  request: {
    confirm: boolean;
    provider?: string;
    model?: string;
    rescreen?: boolean;
  },
): ScreeningInput {
  const definition = stage === "primary" ? preset.primary : preset.refinement;
  if (!definition) throw new Error(`preset ${preset.id} does not define refinement`);
  return stageInput(definition, items, request);
}

export function retainedIds(result: ScreeningResult): string[] {
  return [...result.kept, ...result.undecided, ...result.withheld, ...result.errors].map((entry) => entry.id);
}

function summarize(
  result: ScreeningResult,
  reusedScreening: boolean,
  cacheHits = 0,
  cacheMisses = result.summary.total,
): ScreeningStageSummary {
  const retained = result.summary.kept + result.summary.undecided + result.summary.withheld + result.summary.errors;
  return {
    total: result.summary.total,
    kept: result.summary.kept,
    dropped: result.summary.dropped,
    undecided: result.summary.undecided,
    withheld: result.summary.withheld,
    errors: result.summary.errors,
    retained,
    ...(result.model ? { model: result.model } : {}),
    reusedScreening,
    classifierCalls: result.classifierAccounting?.calls ?? 0,
    cacheHits,
    cacheMisses,
    ...(result.classifierAccounting?.complete && result.classifierAccounting.usage
      ? { classifierUsage: result.classifierAccounting.usage }
      : {}),
  };
}

function efficiency(summary: ScreeningStageSummary): ScreeningEfficiencyMetrics {
  return buildScreeningEfficiency({
    total: summary.total,
    kept: summary.kept,
    dropped: summary.dropped,
    undecided: summary.undecided,
    withheld: summary.withheld,
    errors: summary.errors,
    retained: summary.retained,
    classifierCalls: summary.classifierCalls,
    cacheHits: summary.cacheHits,
    cacheMisses: summary.cacheMisses,
    usage: summary.classifierUsage,
  });
}

function retainedCandidates(items: AdapterCandidate[], result: ScreeningResult): AdapterCandidate[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return retainedIds(result).map((id) => {
    const item = byId.get(id);
    if (!item) throw new Error(`screening result returned unknown candidate id: ${id}`);
    return item;
  });
}

function zeroStageSummary(): ScreeningStageSummary {
  return {
    total: 0,
    kept: 0,
    dropped: 0,
    undecided: 0,
    withheld: 0,
    errors: 0,
    retained: 0,
    reusedScreening: false,
    classifierCalls: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };
}

function reviewError(result: ReviewWorkflowStartResult): string[] {
  return result.status === "ok" ? [] : result.issues.length > 0 ? result.issues : ["failed to start semantic review"];
}

export class PresetScreeningWorkflowManager {
  private byKey = new Map<string, PrimaryRunState>();
  private byId = new Map<string, PrimaryRunState>();
  private nextSequence = 1;

  reset(): void {
    this.byKey.clear();
    this.byId.clear();
    this.nextSequence = 1;
  }

  async startPrimary(
    request: {
      preset: ScreeningPreset;
      scope: string;
      confirm: boolean;
      deferReview?: boolean;
      provider?: string;
      model?: string;
      rescreen?: boolean;
      signal?: AbortSignal;
    },
    dependencies: PresetScreeningWorkflowDependencies,
  ): Promise<PrimaryScreeningStartResult> {
    const scope = request.scope.trim();
    if (!scope) {
      return {
        status: "error",
        preset: request.preset.id,
        scope: request.scope,
        reviewStarted: false,
        refinementAvailable: Boolean(request.preset.refinement),
        refinementDeferred: Boolean(request.deferReview),
        reusedInitialization: false,
        issues: ["scope must not be empty"],
      };
    }

    const key = `${request.preset.id}\n${JSON.stringify(request.preset)}\n${scope}\n${request.provider ?? "<default-provider>"}\n${request.model ?? "<default-model>"}`;
    const existing = request.rescreen === true ? undefined : this.byKey.get(key);
    if (existing) {
      if (request.deferReview === true && existing.review) {
        return {
          status: "error",
          preset: existing.preset.id,
          scope: existing.scope,
          primaryRunId: existing.id,
          primary: existing.primary,
          efficiency: efficiency(existing.primary),
          reviewStarted: true,
          workflowId: existing.review.workflowId,
          progress: existing.review.progress,
          refinementAvailable: Boolean(existing.preset.refinement),
          refinementDeferred: false,
          reusedInitialization: true,
          issues: ["canonical primary already started review; use rescreen:true to request a new refinement path"],
        };
      }
      if (request.deferReview !== true && !existing.review) {
        const review = dependencies.startReview({
          preset: existing.preset,
          scope: existing.scope,
          reviewTargetIds: existing.retainedItems.map((item) => item.id),
        });
        if (review.status !== "ok") {
          return {
            status: "error",
            preset: existing.preset.id,
            scope: existing.scope,
            primaryRunId: existing.id,
            primary: existing.primary,
            efficiency: efficiency(existing.primary),
            reviewStarted: false,
            refinementAvailable: Boolean(existing.preset.refinement),
            refinementDeferred: false,
            reusedInitialization: true,
            issues: reviewError(review),
          };
        }
        existing.review = review;
      }
      return {
        status: "ok",
        preset: existing.preset.id,
        scope: existing.scope,
        primaryRunId: existing.id,
        primary: existing.primary,
        efficiency: efficiency(existing.primary),
        reviewStarted: Boolean(existing.review),
        workflowId: existing.review?.workflowId,
        progress: existing.review?.progress,
        refinementAvailable: Boolean(existing.preset.refinement),
        refinementDeferred: !existing.review,
        reusedInitialization: true,
        issues: [],
      };
    }

    const discovered = await dependencies.discoverCandidates({
      preset: request.preset,
      scope,
      signal: request.signal,
    });
    if (discovered.status !== "ok") {
      return {
        status: "error",
        preset: request.preset.id,
        scope,
        reviewStarted: false,
        refinementAvailable: Boolean(request.preset.refinement),
        refinementDeferred: Boolean(request.deferReview),
        reusedInitialization: false,
        issues: (discovered.issues ?? []).map((issue) => issue.message),
      };
    }

    const items = discovered.items ?? [];
    if (discovered.total !== items.length) {
      return {
        status: "error",
        preset: request.preset.id,
        scope,
        reviewStarted: false,
        refinementAvailable: Boolean(request.preset.refinement),
        refinementDeferred: Boolean(request.deferReview),
        reusedInitialization: false,
        issues: [`candidate discovery mismatch: total=${discovered.total}, items=${items.length}`],
      };
    }

    let primary: ScreeningStageSummary;
    let retained: AdapterCandidate[];
    if (items.length === 0) {
      primary = zeroStageSummary();
      retained = [];
    } else {
      const screened = await dependencies.runStage({
        preset: request.preset,
        stage: "primary",
        items,
        confirm: request.confirm,
        provider: request.provider,
        model: request.model,
        rescreen: request.rescreen,
        signal: request.signal,
      });
      const result = screened.result;
      primary = summarize(result, screened.reused, screened.cacheHits ?? 0, screened.cacheMisses ?? items.length);
      if (result.status !== "ok") {
        return {
          status: result.status,
          preset: request.preset.id,
          scope,
          primary,
          efficiency: efficiency(primary),
          reviewStarted: false,
          refinementAvailable: Boolean(request.preset.refinement),
          refinementDeferred: Boolean(request.deferReview),
          reusedInitialization: false,
          projectedCalls: result.projectedCalls,
          callLimit: result.callLimit,
          issues: result.status === "approval_required" ? [] : ["primary screening did not complete successfully"],
        };
      }
      retained = retainedCandidates(items, result);
    }

    const id = `primary-${this.nextSequence++}`;
    const state: PrimaryRunState = {
      id,
      key,
      preset: request.preset,
      scope,
      provider: request.provider,
      model: request.model,
      retainedItems: retained,
      primary,
    };

    if (request.deferReview !== true) {
      const review = dependencies.startReview({
        preset: request.preset,
        scope,
        reviewTargetIds: retained.map((item) => item.id),
      });
      if (review.status !== "ok") {
        return {
          status: "error",
          preset: request.preset.id,
          scope,
          primaryRunId: id,
          primary,
          efficiency: efficiency(primary),
          reviewStarted: false,
          refinementAvailable: Boolean(request.preset.refinement),
          refinementDeferred: false,
          reusedInitialization: false,
          issues: reviewError(review),
        };
      }
      state.review = review;
    }

    this.byKey.set(key, state);
    this.byId.set(id, state);
    return {
      status: "ok",
      preset: request.preset.id,
      scope,
      primaryRunId: id,
      primary,
      efficiency: efficiency(primary),
      reviewStarted: Boolean(state.review),
      workflowId: state.review?.workflowId,
      progress: state.review?.progress,
      refinementAvailable: Boolean(request.preset.refinement),
      refinementDeferred: !state.review,
      reusedInitialization: false,
      issues: [],
    };
  }

  async startRefinement(
    request: {
      primaryRunId: string;
      confirm: boolean;
      rescreen?: boolean;
      signal?: AbortSignal;
    },
    dependencies: PresetScreeningWorkflowDependencies,
  ): Promise<RefinementScreeningStartResult> {
    const state = this.byId.get(request.primaryRunId);
    if (!state) {
      return {
        status: "error",
        primaryRunId: request.primaryRunId,
        reviewStarted: false,
        reusedInitialization: false,
        issues: [`unknown primary run: ${request.primaryRunId}`],
      };
    }
    if (!state.preset.refinement) {
      return {
        status: "error",
        preset: state.preset.id,
        scope: state.scope,
        primaryRunId: state.id,
        primary: state.primary,
        efficiency: efficiency(state.primary),
        reviewStarted: Boolean(state.review),
        workflowId: state.review?.workflowId,
        progress: state.review?.progress,
        reusedInitialization: true,
        issues: [`preset ${state.preset.id} does not define refinement`],
      };
    }
    if (state.refinement && state.review && request.rescreen !== true) {
      return {
        status: "ok",
        preset: state.preset.id,
        scope: state.scope,
        primaryRunId: state.id,
        primary: state.primary,
        efficiency: efficiency(state.primary),
        refinement: state.refinement,
        reviewStarted: true,
        workflowId: state.review.workflowId,
        progress: state.review.progress,
        reusedInitialization: true,
        issues: [],
      };
    }
    if (state.review && request.rescreen !== true) {
      return {
        status: "error",
        preset: state.preset.id,
        scope: state.scope,
        primaryRunId: state.id,
        primary: state.primary,
        efficiency: efficiency(state.primary),
        reviewStarted: true,
        workflowId: state.review.workflowId,
        progress: state.review.progress,
        reusedInitialization: true,
        issues: ["review already started for this primary run"],
      };
    }

    let refinement: ScreeningStageSummary & { refinementYield: number; lowYield: boolean };
    let reviewTargetIds: string[];
    if (state.retainedItems.length === 0) {
      refinement = { ...zeroStageSummary(), refinementYield: 0, lowYield: true };
      reviewTargetIds = [];
    } else {
      const screened = await dependencies.runStage({
        preset: state.preset,
        stage: "refinement",
        items: state.retainedItems,
        confirm: request.confirm,
        provider: state.provider,
        model: state.model,
        rescreen: request.rescreen,
        signal: request.signal,
      });
      const result = screened.result;
      const summary = summarize(result, screened.reused, screened.cacheHits ?? 0, screened.cacheMisses ?? state.retainedItems.length);
      const refinementYield = state.primary.retained > 0 ? result.summary.dropped / state.primary.retained : 0;
      refinement = { ...summary, refinementYield, lowYield: refinementYield < 0.30 };
      if (result.status !== "ok") {
        return {
          status: result.status,
          preset: state.preset.id,
          scope: state.scope,
          primaryRunId: state.id,
          primary: state.primary,
          efficiency: efficiency(state.primary),
          refinement,
          reviewStarted: false,
          reusedInitialization: false,
          projectedCalls: result.projectedCalls,
          callLimit: result.callLimit,
          issues: result.status === "approval_required" ? [] : ["refinement screening did not complete successfully"],
        };
      }
      reviewTargetIds = retainedIds(result);
    }

    const review = dependencies.startReview({
      preset: state.preset,
      scope: state.scope,
      reviewTargetIds,
    });
    if (review.status !== "ok") {
      return {
        status: "error",
        preset: state.preset.id,
        scope: state.scope,
        primaryRunId: state.id,
        primary: state.primary,
        efficiency: efficiency(state.primary),
        refinement,
        reviewStarted: false,
        reusedInitialization: false,
        issues: reviewError(review),
      };
    }

    state.refinement = refinement;
    state.review = review;
    return {
      status: "ok",
      preset: state.preset.id,
      scope: state.scope,
      primaryRunId: state.id,
      primary: state.primary,
      efficiency: efficiency(state.primary),
      refinement,
      reviewStarted: true,
      workflowId: review.workflowId,
      progress: review.progress,
      reusedInitialization: false,
      issues: [],
    };
  }
}
