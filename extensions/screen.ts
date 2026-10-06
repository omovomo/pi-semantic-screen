import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult, JsonValue } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  ModelRuntime,
  estimateTokens,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type ClassifierBackend,
  type ClassifierContextLike,
  type ClassifierModelRef,
  type ScreeningInput,
  type ScreeningResult,
  classifyBatch,
} from "../src/engine.ts";
import { ClassificationResultCache, runWithClassificationCache } from "../src/cache.ts";
import { screeningPreflight } from "../src/preflight.ts";
import { redactSecrets } from "../src/redaction.ts";
import { resolvePresetEvidenceProvider } from "../src/providers/registry.ts";
import { getPreset, listPresets } from "../src/presets/registry.ts";
import { boundEvidenceByTokens } from "../src/evidence-budget.ts";
import { buildReviewContract } from "../src/review-contract.ts";
import {
  applyReviewDispositions,
  type ReviewDecision,
  type ReviewDecisionInput,
} from "../src/review-apply.ts";
import { ReviewWorkflowManager, type ReviewEvidencePacket } from "../src/review-workflow.ts";
import {
  PresetScreeningWorkflowManager,
  exactPresetStageInput,
} from "../src/preset-screening-workflow.ts";

let runtimePromise: Promise<ModelRuntime> | undefined;
const classificationCache = new ClassificationResultCache(50_000);

function getRuntime(): Promise<ModelRuntime> {
  if (!runtimePromise) {
    runtimePromise = ModelRuntime.create({
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
  }
  return runtimePromise;
}

function parsePositiveEnvInt(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) return fallback;
  return value;
}

function parseNonNegativeEnvInt(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > max) return fallback;
  return value;
}

function agentMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function isSemanticScreenPrompt(prompt: string): boolean {
  return /semantic_screen_review_state|screen_preset|screen_discover|screen_primary_start|screen_primary_manifest|screen_refinement_start|screen_evidence|screen_review_apply|screen_review_start|screen_review_next|screen_review_commit|screen_preflight|screen_batch|screen-use|screen-exceptions|screen-continue/i.test(prompt);
}

function isSemanticScreenComplete(text: string): boolean {
  return /resumeAvailable\s*[=:]\s*false|no_resumable_screen_state/i.test(text);
}

function parseEnvClassifier(): { provider: string; model: string } | undefined {
  const raw = process.env.PI_SEMANTIC_SCREEN_CLASSIFIER?.trim();
  if (!raw) return undefined;
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) {
    throw new Error("PI_SEMANTIC_SCREEN_CLASSIFIER must use provider/model format");
  }
  return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
}

function modelRef(model: ClassifierModel<ClassifierApi>): ClassifierModelRef {
  return {
    provider: model.provider,
    id: model.id,
    contextWindow: model.contextWindow,
  };
}

async function resolveClassifierModel(
  runtime: ModelRuntime,
  request: { provider?: string; model?: string; signal?: AbortSignal },
): Promise<ClassifierModel<ClassifierApi>> {
  const refresh = await runtime.refresh({ allowNetwork: false, signal: request.signal });
  if (refresh.aborted || request.signal?.aborted) throw new Error("classifier model refresh aborted");

  const available = [...(await runtime.getAvailableOfType("classifier", request.provider, { signal: request.signal }))];
  if (request.signal?.aborted) throw new Error("classifier model discovery aborted");

  if (request.provider && request.model) {
    const exact = available.find((candidate) => candidate.provider === request.provider && candidate.id === request.model);
    if (!exact) throw new Error(`classifier ${request.provider}/${request.model} is not available/configured`);
    return exact;
  }

  if (request.provider) {
    if (available.length === 0) throw new Error(`no available classifier model for provider ${request.provider}`);
    return available[0];
  }

  if (request.model) {
    const match = available.find((candidate) => candidate.id === request.model);
    if (!match) throw new Error(`classifier model id ${request.model} is not available/configured`);
    return match;
  }

  const envPreference = parseEnvClassifier();
  if (envPreference) {
    const envExact = available.find(
      (candidate) => candidate.provider === envPreference.provider && candidate.id === envPreference.model,
    );
    if (!envExact) {
      throw new Error(`classifier ${envPreference.provider}/${envPreference.model} from PI_SEMANTIC_SCREEN_CLASSIFIER is not available/configured`);
    }
    return envExact;
  }

  if (available.length === 0) {
    throw new Error("no usable classifier model is available; configure classifier auth/model in Pi");
  }
  return available[0];
}

function createBackend(signal?: AbortSignal): ClassifierBackend {
  const selected = new Map<string, ClassifierModel<ClassifierApi>>();
  return {
    async selectModel(request) {
      const runtime = await getRuntime();
      const model = await resolveClassifierModel(runtime, { ...request, signal });
      selected.set(`${model.provider}\n${model.id}`, model);
      return modelRef(model);
    },
    async classify(model, context, options) {
      const runtime = await getRuntime();
      const concrete = selected.get(`${model.provider}\n${model.id}`) ??
        runtime.getModelOfType("classifier", model.provider, model.id);
      if (!concrete) {
        return {
          stopReason: "error",
          errorMessage: `classifier ${model.provider}/${model.id} disappeared after selection`,
          answers: {},
        };
      }
      return (await runtime.classify(
        concrete,
        context as ClassifierContext,
        { signal: options.signal },
      )) as ClassifierResult;
    },
  };
}

async function resolveClassifierInput(input: ScreeningInput, signal?: AbortSignal): Promise<{
  input: ScreeningInput;
  identity: { provider: string; id: string; implementation: string };
}> {
  const runtime = await getRuntime();
  const selected = await resolveClassifierModel(runtime, {
    provider: input.provider,
    model: input.model,
    signal,
  });
  return {
    input: { ...input, provider: selected.provider, model: selected.id },
    identity: { provider: selected.provider, id: selected.id, implementation: "pi-classifier-v1" },
  };
}

function estimateClassifierTokens(text: string): number {
  return estimateTokens({ role: "user", content: text, timestamp: 0 });
}

const probabilityItem = Type.Object(
  {
    id: Type.String(),
    probability: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);

const withheldItem = Type.Object(
  {
    id: Type.String(),
    reason: Type.Union([Type.Literal("too_large"), Type.Literal("approval_required")]),
  },
  { additionalProperties: false },
);

const errorItem = Type.Object(
  {
    id: Type.String(),
    reason: Type.Union([
      Type.Literal("classifier_error"),
      Type.Literal("classifier_exception"),
      Type.Literal("malformed_answer"),
      Type.Literal("aborted"),
      Type.Literal("model_unavailable"),
    ]),
    message: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const outputSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ok"), Type.Literal("approval_required"), Type.Literal("error")]),
    model: Type.Optional(
      Type.Object({ provider: Type.String(), id: Type.String() }, { additionalProperties: false }),
    ),
    summary: Type.Object(
      {
        total: Type.Integer({ minimum: 0 }),
        kept: Type.Integer({ minimum: 0 }),
        dropped: Type.Integer({ minimum: 0 }),
        undecided: Type.Integer({ minimum: 0 }),
        withheld: Type.Integer({ minimum: 0 }),
        errors: Type.Integer({ minimum: 0 }),
        redactedItems: Type.Integer({ minimum: 0 }),
        redactionCount: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    kept: Type.Array(probabilityItem),
    dropped: Type.Array(probabilityItem),
    undecided: Type.Array(probabilityItem),
    withheld: Type.Array(withheldItem),
    errors: Type.Array(errorItem),
    projectedCalls: Type.Optional(Type.Integer({ minimum: 0 })),
    callLimit: Type.Optional(Type.Integer({ minimum: 1 })),
    classifierAccounting: Type.Optional(
      Type.Object(
        {
          calls: Type.Integer({ minimum: 0 }),
          usageReportedCalls: Type.Integer({ minimum: 0 }),
          complete: Type.Boolean(),
          usage: Type.Optional(
            Type.Object(
              {
                input: Type.Number({ minimum: 0 }),
                output: Type.Number({ minimum: 0 }),
                cacheRead: Type.Number({ minimum: 0 }),
                cacheWrite: Type.Number({ minimum: 0 }),
                cacheWrite1h: Type.Optional(Type.Number({ minimum: 0 })),
                reasoning: Type.Optional(Type.Number({ minimum: 0 })),
                totalTokens: Type.Number({ minimum: 0 }),
                cost: Type.Object(
                  {
                    input: Type.Number({ minimum: 0 }),
                    output: Type.Number({ minimum: 0 }),
                    cacheRead: Type.Number({ minimum: 0 }),
                    cacheWrite: Type.Number({ minimum: 0 }),
                    total: Type.Number({ minimum: 0 }),
                  },
                  { additionalProperties: false },
                ),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    reused: Type.Optional(Type.Boolean()),
    cacheHits: Type.Optional(Type.Integer({ minimum: 0 })),
    cacheMisses: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);


const stagePresetSchema = Type.Object(
  {
    question: Type.String(),
    criteria: Type.Object(
      { true: Type.String(), false: Type.String() },
      { additionalProperties: false },
    ),
    threshold: Type.Number(),
  },
  { additionalProperties: false },
);

const presetOutputSchema = Type.Object(
  {
    status: Type.Literal("ok"),
    presets: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: Type.String(),
            label: Type.String(),
            description: Type.String(),
            adapter: Type.String(),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    preset: Type.Optional(
      Type.Object(
        {
          id: Type.String(),
          label: Type.String(),
          description: Type.String(),
          adapter: Type.String(),
          provider: Type.Optional(Type.Unknown()),
          primary: stagePresetSchema,
          refinement: Type.Optional(stagePresetSchema),
          review: Type.Object(
            { instructions: Type.String(), confirmWhen: Type.String(), rejectWhen: Type.String() },
            { additionalProperties: false },
          ),
          evidence: Type.Object(
            {
              targetItems: Type.Integer({ minimum: 1 }),
              maxItems: Type.Integer({ minimum: 1 }),
              maxSources: Type.Integer({ minimum: 1 }),
              maxChars: Type.Integer({ minimum: 1 }),
              maxTokens: Type.Integer({ minimum: 1 }),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const presetParameters = Type.Object(
  { id: Type.Optional(Type.String({ minLength: 1, description: "Preset id. Omit to list available presets." })) },
  { additionalProperties: false },
);

const discoverParameters = Type.Object(
  {
    preset: Type.String({ minLength: 1 }),
    scope: Type.String({ minLength: 1 }),
    mode: Type.Union([Type.Literal("count"), Type.Literal("candidates")]),
  },
  { additionalProperties: false },
);

const discoverOutputSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ok"), Type.Literal("error")]),
    adapter: Type.String(),
    preset: Type.String(),
    scope: Type.String(),
    total: Type.Integer({ minimum: 0 }),
    items: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: Type.String(),
            text: Type.String(),
            source: Type.Optional(Type.String()),
            line: Type.Optional(Type.Integer({ minimum: 1 })),
            column: Type.Optional(Type.Integer({ minimum: 1 })),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    issues: Type.Optional(
      Type.Array(
        Type.Object(
          { source: Type.Optional(Type.String()), message: Type.String() },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);

const evidenceParameters = Type.Object(
  {
    preset: Type.String({ minLength: 1 }),
    scope: Type.String({ minLength: 1 }),
    ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    maxSources: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 250000 })),
    maxTokens: Type.Optional(Type.Integer({ minimum: 1000, maximum: 20000 })),
    detail: Type.Optional(Type.Union([Type.Literal("standard"), Type.Literal("expanded")])),
  },
  { additionalProperties: false },
);

const reviewDispositionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    terminal: Type.Boolean(),
    finding: Type.Boolean(),
    description: Type.String(),
  },
  { additionalProperties: false },
);

const reviewContractSchema = Type.Object(
  {
    instructions: Type.String(),
    confirmWhen: Type.String(),
    rejectWhen: Type.String(),
    dispositions: Type.Array(reviewDispositionSchema),
    insufficientEvidenceAction: Type.String(),
  },
  { additionalProperties: false },
);

const evidenceOutputSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ok"), Type.Literal("error")]),
    adapter: Type.String(),
    preset: Type.String(),
    scope: Type.String(),
    detail: Type.Union([Type.Literal("standard"), Type.Literal("expanded")]),
    reviewContract: reviewContractSchema,
    requested: Type.Integer({ minimum: 0 }),
    packetIds: Type.Array(Type.String()),
    sourceCount: Type.Integer({ minimum: 0 }),
    chars: Type.Integer({ minimum: 0 }),
    tokenBudget: Type.Integer({ minimum: 1 }),
    estimatedTokens: Type.Integer({ minimum: 0 }),
    trimmed: Type.Boolean(),
    trimReason: Type.Union([
      Type.Literal("none"),
      Type.Literal("adapter_bounds"),
      Type.Literal("token_budget"),
      Type.Literal("adapter_and_token_budget"),
    ]),
    items: Type.Array(
      Type.Object(
        { id: Type.String(), source: Type.String(), evidence: Type.String() },
        { additionalProperties: false },
      ),
    ),
    issues: Type.Optional(
      Type.Array(
        Type.Object(
          { source: Type.Optional(Type.String()), message: Type.String() },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);

const reviewDecisionInputSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    disposition: Type.String({ minLength: 1 }),
    rationale: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const reviewDecisionTupleSchema = Type.Tuple([
  Type.String({ minLength: 1 }),
  Type.String({ minLength: 1 }),
  Type.String({ minLength: 1 }),
]);

const reviewDecisionCommitSchema = Type.Union([reviewDecisionInputSchema, reviewDecisionTupleSchema]);

const reviewDispositionCountsSchema = Type.Object({}, { additionalProperties: Type.Integer({ minimum: 0 }) });

const reviewApplyParameters = Type.Object(
  {
    preset: Type.String({ minLength: 1 }),
    detail: Type.Union([Type.Literal("standard"), Type.Literal("expanded")]),
    packetIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    dispositions: Type.Array(reviewDecisionInputSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

const reviewApplyOutputSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ok"), Type.Literal("error")]),
    preset: Type.String(),
    detail: Type.Union([Type.Literal("standard"), Type.Literal("expanded")]),
    packetIds: Type.Array(Type.String()),
    reviewedIds: Type.Array(Type.String()),
    evidenceSeenIds: Type.Array(Type.String()),
    needsExpandedEvidenceIds: Type.Array(Type.String()),
    blockedEvidence: Type.Array(
      Type.Object({ id: Type.String(), rationale: Type.String() }, { additionalProperties: false }),
    ),
    findings: Type.Array(
      Type.Object({ id: Type.String(), rationale: Type.String() }, { additionalProperties: false }),
    ),
    dispositionCounts: reviewDispositionCountsSchema,
    issues: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);


const reviewWorkflowProgressSchema = Type.Object(
  {
    reviewTarget: Type.Integer({ minimum: 0 }),
    semanticallyReviewed: Type.Integer({ minimum: 0 }),
    evidenceSeen: Type.Integer({ minimum: 0 }),
    blockedEvidence: Type.Integer({ minimum: 0 }),
    needsExpandedEvidence: Type.Integer({ minimum: 0 }),
    reviewableRemaining: Type.Integer({ minimum: 0 }),
    confirmed: Type.Integer({ minimum: 0 }),
    unreviewed: Type.Integer({ minimum: 0 }),
    standardReviewed: Type.Integer({ minimum: 0 }),
    standardResolved: Type.Integer({ minimum: 0 }),
    expandedAttempted: Type.Integer({ minimum: 0 }),
    expandedResolved: Type.Integer({ minimum: 0 }),
    expandedBlocked: Type.Integer({ minimum: 0 }),
    expansionRate: Type.Number({ minimum: 0, maximum: 1 }),
    expandedResolutionRate: Type.Number({ minimum: 0, maximum: 1 }),
    resumeAvailable: Type.Boolean(),
  },
  { additionalProperties: false },
);

const reviewFindingSchema = Type.Object(
  { id: Type.String(), rationale: Type.String() },
  { additionalProperties: false },
);

const reviewStartParameters = Type.Object(
  {
    preset: Type.String({ minLength: 1 }),
    scope: Type.String({ minLength: 1 }),
    reviewTargetIds: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const reviewStartOutputSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ok"), Type.Literal("error")]),
    workflowId: Type.Optional(Type.String()),
    preset: Type.String(),
    scope: Type.String(),
    progress: Type.Optional(reviewWorkflowProgressSchema),
    issues: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

const reviewNextParameters = Type.Object(
  { workflowId: Type.Optional(Type.String({ minLength: 1 })) },
  { additionalProperties: false },
);

const reviewNextOutputSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("packet"),
      Type.Literal("complete"),
      Type.Literal("review_complete_with_blocked_evidence"),
      Type.Literal("error"),
    ]),
    workflowId: Type.Optional(Type.String()),
    packetId: Type.Optional(Type.String()),
    preset: Type.Optional(Type.String()),
    scope: Type.Optional(Type.String()),
    progress: Type.Optional(reviewWorkflowProgressSchema),
    packet: Type.Optional(evidenceOutputSchema),
    findings: Type.Optional(Type.Array(reviewFindingSchema)),
    blockedEvidence: Type.Optional(Type.Array(reviewFindingSchema)),
    dispositionCounts: Type.Optional(reviewDispositionCountsSchema),
    dispositionEventCounts: Type.Optional(reviewDispositionCountsSchema),
    finalDispositionCounts: Type.Optional(reviewDispositionCountsSchema),
    issues: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

const reviewCommitParameters = Type.Object(
  {
    workflowId: Type.Optional(Type.String({ minLength: 1 })),
    packetId: Type.String({ minLength: 1 }),
    dispositions: Type.Array(reviewDecisionCommitSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

const reviewCommitOutputSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("ready"),
      Type.Literal("complete"),
      Type.Literal("review_complete_with_blocked_evidence"),
      Type.Literal("error"),
    ]),
    workflowId: Type.Optional(Type.String()),
    packetId: Type.Optional(Type.String()),
    progress: Type.Optional(reviewWorkflowProgressSchema),
    newFindings: Type.Array(reviewFindingSchema),
    newBlockedEvidence: Type.Array(reviewFindingSchema),
    findings: Type.Optional(Type.Array(reviewFindingSchema)),
    blockedEvidence: Type.Optional(Type.Array(reviewFindingSchema)),
    dispositionCounts: Type.Optional(reviewDispositionCountsSchema),
    dispositionEventCounts: Type.Optional(reviewDispositionCountsSchema),
    finalDispositionCounts: Type.Optional(reviewDispositionCountsSchema),
    issues: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

const screeningStageSummarySchema = Type.Object(
  {
    total: Type.Integer({ minimum: 0 }),
    kept: Type.Integer({ minimum: 0 }),
    dropped: Type.Integer({ minimum: 0 }),
    undecided: Type.Integer({ minimum: 0 }),
    withheld: Type.Integer({ minimum: 0 }),
    errors: Type.Integer({ minimum: 0 }),
    retained: Type.Integer({ minimum: 0 }),
    model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() }, { additionalProperties: false })),
    reusedScreening: Type.Boolean(),
    classifierCalls: Type.Integer({ minimum: 0 }),
    cacheHits: Type.Integer({ minimum: 0 }),
    cacheMisses: Type.Integer({ minimum: 0 }),
    classifierUsage: Type.Optional(
      Type.Object(
        {
          input: Type.Number({ minimum: 0 }), output: Type.Number({ minimum: 0 }),
          cacheRead: Type.Number({ minimum: 0 }), cacheWrite: Type.Number({ minimum: 0 }),
          cacheWrite1h: Type.Optional(Type.Number({ minimum: 0 })),
          reasoning: Type.Optional(Type.Number({ minimum: 0 })),
          totalTokens: Type.Number({ minimum: 0 }),
          cost: Type.Object(
            { input: Type.Number({ minimum: 0 }), output: Type.Number({ minimum: 0 }), cacheRead: Type.Number({ minimum: 0 }), cacheWrite: Type.Number({ minimum: 0 }), total: Type.Number({ minimum: 0 }) },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const efficiencySchema = Type.Object(
  {
    discovered: Type.Integer({ minimum: 0 }),
    primaryEvaluated: Type.Integer({ minimum: 0 }),
    primaryCacheHits: Type.Integer({ minimum: 0 }),
    primaryCacheMisses: Type.Integer({ minimum: 0 }),
    dropped: Type.Integer({ minimum: 0 }),
    kept: Type.Integer({ minimum: 0 }),
    undecided: Type.Integer({ minimum: 0 }),
    retained: Type.Integer({ minimum: 0 }),
    withheld: Type.Integer({ minimum: 0 }),
    errors: Type.Integer({ minimum: 0 }),
    primaryReductionRate: Type.Number({ minimum: 0, maximum: 1 }),
    reviewAvoided: Type.Integer({ minimum: 0 }),
    reviewAvoidanceRate: Type.Number({ minimum: 0, maximum: 1 }),
    primaryCacheHitRate: Type.Number({ minimum: 0, maximum: 1 }),
    classifierInputTokens: Type.Optional(Type.Number({ minimum: 0 })),
    classifierOutputTokens: Type.Optional(Type.Number({ minimum: 0 })),
    classifierTotalTokens: Type.Optional(Type.Number({ minimum: 0 })),
    classifierCost: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const primaryStartParameters = Type.Object(
  {
    preset: Type.String({ minLength: 1 }),
    scope: Type.String({ minLength: 1 }),
    confirm: Type.Optional(Type.Boolean({ description: "Set true only after explicit approval when the primary call guard requires it." })),
    deferReview: Type.Optional(Type.Boolean({ description: "Set true only for an explicitly requested refinement path." })),
    provider: Type.Optional(Type.String({ minLength: 1 })),
    model: Type.Optional(Type.String({ minLength: 1 })),
    rescreen: Type.Optional(Type.Boolean({ description: "Bypass the in-session per-candidate classifier cache. Source discovery already runs on every primary start." })),
  },
  { additionalProperties: false },
);

const primaryStartOutputSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ok"), Type.Literal("approval_required"), Type.Literal("error")]),
    preset: Type.String(),
    scope: Type.String(),
    primaryRunId: Type.Optional(Type.String()),
    primary: Type.Optional(screeningStageSummarySchema),
    efficiency: Type.Optional(efficiencySchema),
    reviewStarted: Type.Boolean(),
    workflowId: Type.Optional(Type.String()),
    progress: Type.Optional(reviewWorkflowProgressSchema),
    refinementAvailable: Type.Boolean(),
    refinementDeferred: Type.Boolean(),
    reusedInitialization: Type.Boolean(),
    projectedCalls: Type.Optional(Type.Integer({ minimum: 0 })),
    callLimit: Type.Optional(Type.Integer({ minimum: 1 })),
    issues: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

const primaryOutcomeLabelSchema = Type.Union([
  Type.Literal("KEEP"),
  Type.Literal("DROP"),
  Type.Literal("UNDECIDED"),
  Type.Literal("WITHHELD"),
  Type.Literal("ERROR"),
]);

const primaryManifestParameters = Type.Object(
  {
    primaryRunId: Type.String({ minLength: 1 }),
    labels: Type.Optional(Type.Array(primaryOutcomeLabelSchema, { minItems: 1, maxItems: 5 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  },
  { additionalProperties: false },
);

const primaryManifestOutputSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ok"), Type.Literal("error")]),
    primaryRunId: Type.String(),
    preset: Type.Optional(Type.String()),
    scope: Type.Optional(Type.String()),
    threshold: Type.Optional(Type.Number({ minimum: 0.5, maximum: 1 })),
    keepThreshold: Type.Optional(Type.Number({ minimum: 0.5, maximum: 1 })),
    dropThreshold: Type.Optional(Type.Number({ minimum: 0, maximum: 0.499999999999 })),
    labels: Type.Array(primaryOutcomeLabelSchema),
    total: Type.Integer({ minimum: 0 }),
    matched: Type.Integer({ minimum: 0 }),
    offset: Type.Integer({ minimum: 0 }),
    limit: Type.Integer({ minimum: 1 }),
    returned: Type.Integer({ minimum: 0 }),
    items: Type.Array(Type.Object(
      {
        id: Type.String(),
        source: Type.Optional(Type.String()),
        line: Type.Optional(Type.Integer({ minimum: 1 })),
        column: Type.Optional(Type.Integer({ minimum: 1 })),
        label: primaryOutcomeLabelSchema,
        keepProbability: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        reason: Type.String(),
      },
      { additionalProperties: false },
    )),
    issues: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

const refinementSummarySchema = Type.Object(
  {
    total: Type.Integer({ minimum: 0 }),
    kept: Type.Integer({ minimum: 0 }),
    dropped: Type.Integer({ minimum: 0 }),
    undecided: Type.Integer({ minimum: 0 }),
    withheld: Type.Integer({ minimum: 0 }),
    errors: Type.Integer({ minimum: 0 }),
    retained: Type.Integer({ minimum: 0 }),
    model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() }, { additionalProperties: false })),
    reusedScreening: Type.Boolean(),
    classifierCalls: Type.Integer({ minimum: 0 }),
    cacheHits: Type.Integer({ minimum: 0 }),
    cacheMisses: Type.Integer({ minimum: 0 }),
    classifierUsage: Type.Optional(
      Type.Object(
        {
          input: Type.Number({ minimum: 0 }), output: Type.Number({ minimum: 0 }),
          cacheRead: Type.Number({ minimum: 0 }), cacheWrite: Type.Number({ minimum: 0 }),
          cacheWrite1h: Type.Optional(Type.Number({ minimum: 0 })),
          reasoning: Type.Optional(Type.Number({ minimum: 0 })),
          totalTokens: Type.Number({ minimum: 0 }),
          cost: Type.Object(
            { input: Type.Number({ minimum: 0 }), output: Type.Number({ minimum: 0 }), cacheRead: Type.Number({ minimum: 0 }), cacheWrite: Type.Number({ minimum: 0 }), total: Type.Number({ minimum: 0 }) },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    ),
    refinementYield: Type.Number({ minimum: 0, maximum: 1 }),
    lowYield: Type.Boolean(),
  },
  { additionalProperties: false },
);

const refinementStartParameters = Type.Object(
  {
    primaryRunId: Type.String({ minLength: 1 }),
    confirm: Type.Optional(Type.Boolean({ description: "Set true only after explicit approval when the refinement call guard requires it." })),
    rescreen: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const refinementStartOutputSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ok"), Type.Literal("approval_required"), Type.Literal("error")]),
    preset: Type.Optional(Type.String()),
    scope: Type.Optional(Type.String()),
    primaryRunId: Type.Optional(Type.String()),
    primary: Type.Optional(screeningStageSummarySchema),
    efficiency: Type.Optional(efficiencySchema),
    refinement: Type.Optional(refinementSummarySchema),
    reviewStarted: Type.Boolean(),
    workflowId: Type.Optional(Type.String()),
    progress: Type.Optional(reviewWorkflowProgressSchema),
    reusedInitialization: Type.Boolean(),
    projectedCalls: Type.Optional(Type.Integer({ minimum: 0 })),
    callLimit: Type.Optional(Type.Integer({ minimum: 1 })),
    issues: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

const preflightOutputSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ok"), Type.Literal("approval_required")]),
    projectedCalls: Type.Integer({ minimum: 1 }),
    callLimit: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const preflightParameters = Type.Object(
  {
    count: Type.Integer({
      minimum: 1,
      description: "Projected classifier calls. Use this before constructing large candidate text payloads.",
    }),
  },
  { additionalProperties: false },
);

const parameters = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, description: "Stable unique candidate identifier" }),
          text: Type.String({ description: "Only this text is sent to the classifier after redaction" }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    question: Type.String({ minLength: 1, description: "Boolean screening question/instructions" }),
    criteria: Type.Optional(
      Type.Object(
        {
          true: Type.String({ minLength: 1 }),
          false: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    threshold: Type.Optional(
      Type.Number({ exclusiveMinimum: 0.5, maximum: 1, description: "Legacy symmetric keep threshold. Default 0.70; DROP uses 1-threshold unless dropThreshold is explicit." }),
    ),
    keepThreshold: Type.Optional(
      Type.Number({ exclusiveMinimum: 0.5, maximum: 1, description: "Explicit keep threshold; must match threshold when both are supplied." }),
    ),
    dropThreshold: Type.Optional(
      Type.Number({ minimum: 0, exclusiveMaximum: 0.5, description: "Explicit fail-closed DROP threshold." }),
    ),
    provider: Type.Optional(Type.String({ minLength: 1 })),
    model: Type.Optional(Type.String({ minLength: 1 })),
    confirm: Type.Optional(
      Type.Boolean({ description: "Override only the deterministic batch call-count guard" }),
    ),
    rescreen: Type.Optional(
      Type.Boolean({
        description:
          "Bypass in-memory reuse and run a fresh classifier pass. Use only after an explicit user request to rescreen.",
      }),
    ),
  },
  { additionalProperties: false },
);


async function buildEvidencePacket(request: {
  preset: string;
  scope: string;
  ids: string[];
  maxItems?: number;
  maxSources?: number;
  maxChars?: number;
  maxTokens?: number;
  detail?: "standard" | "expanded";
  presetDefinition?: ReturnType<typeof getPreset>;
  signal?: AbortSignal;
}): Promise<ReviewEvidencePacket> {
  const preset = request.presetDefinition ?? getPreset(request.preset);
  const adapter = resolvePresetEvidenceProvider(preset);
  const detail = request.detail ?? "standard";
  const result = await adapter.evidence({
    scope: request.scope,
    ids: request.ids,
    maxItems: request.maxItems ?? preset.evidence.maxItems,
    maxSources: request.maxSources ?? preset.evidence.maxSources,
    maxChars: request.maxChars ?? preset.evidence.maxChars,
    detail,
    signal: request.signal,
  });
  const reviewContract = buildReviewContract(preset);
  const bounded = boundEvidenceByTokens(
    result,
    request.maxTokens ?? preset.evidence.maxTokens,
    estimateClassifierTokens,
    { preset: preset.id, detail, reviewContract },
  );
  const adapterTrimmed = result.status === "ok" && result.packetIds.length < result.requested;
  const tokenTrimmed = result.status === "ok" && bounded.status === "ok" && bounded.packetIds.length < result.packetIds.length;
  const trimReason =
    adapterTrimmed && tokenTrimmed
      ? "adapter_and_token_budget"
      : tokenTrimmed
        ? "token_budget"
        : adapterTrimmed
          ? "adapter_bounds"
          : "none";
  return {
    ...bounded,
    preset: preset.id,
    detail,
    reviewContract,
    trimmed: bounded.status === "ok" && bounded.packetIds.length < bounded.requested,
    trimReason,
  } as ReviewEvidencePacket;
}

export default function semanticScreenExtension(pi: ExtensionAPI) {
  let semanticScreenWorkflowActive = false;
  let compactionInFlight = false;
  const reviewWorkflows = new ReviewWorkflowManager();
  const reviewPresetSnapshots = new Map<string, ReturnType<typeof getPreset>>();
  const presetScreeningWorkflows = new PresetScreeningWorkflowManager();

  const presetWorkflowDependencies = (
    signal?: AbortSignal,
    onScreened?: (screened: Awaited<ReturnType<typeof runWithClassificationCache>>) => void,
  ) => ({
    async discoverCandidates(request: { preset: ReturnType<typeof getPreset>; scope: string; signal?: AbortSignal }) {
      const adapter = resolvePresetEvidenceProvider(request.preset);
      return adapter.discover({ scope: request.scope, mode: "candidates", signal: request.signal });
    },
    async runStage(request: {
      preset: ReturnType<typeof getPreset>;
      stage: "primary" | "refinement";
      items: Array<{ id: string; text: string }>;
      confirm: boolean;
      provider?: string;
      model?: string;
      rescreen?: boolean;
      signal?: AbortSignal;
    }) {
      const unresolvedInput = exactPresetStageInput(request.preset, request.stage, request.items, {
        confirm: request.confirm,
        provider: request.provider,
        model: request.model,
        rescreen: request.rescreen,
      });
      const resolved = await resolveClassifierInput(unresolvedInput, request.signal ?? signal);
      const screened = await runWithClassificationCache(resolved.input, resolved.identity, classificationCache, (missInput) =>
        classifyBatch(missInput, createBackend(request.signal ?? signal), {
          callLimit: parsePositiveEnvInt("PI_SEMANTIC_SCREEN_CALL_LIMIT", 200, 100_000),
          concurrency: parsePositiveEnvInt("PI_SEMANTIC_SCREEN_CONCURRENCY", 12, 64),
          contextSafetyFraction: 0.85,
          estimateTokens: estimateClassifierTokens,
          redact: redactSecrets,
          signal: request.signal ?? signal,
        }),
      );
      onScreened?.(screened);
      return screened;
    },
    startReview(request: { preset: ReturnType<typeof getPreset>; scope: string; reviewTargetIds: string[] }) {
      const started = reviewWorkflows.start({
        preset: request.preset.id,
        scope: request.scope,
        reviewTargetIds: request.reviewTargetIds,
        targetItems: request.preset.evidence.targetItems,
        reviewContract: buildReviewContract(request.preset),
      });
      if (started.status === "ok" && started.workflowId) {
        reviewPresetSnapshots.set(started.workflowId, structuredClone(request.preset));
      }
      return started;
    },
  });

  pi.on("session_start", () => {
    semanticScreenWorkflowActive = false;
    compactionInFlight = false;
    reviewWorkflows.reset();
    reviewPresetSnapshots.clear();
    presetScreeningWorkflows.reset();
    classificationCache.clear();
  });

  pi.on("before_agent_start", (event) => {
    if (isSemanticScreenPrompt(event.prompt)) semanticScreenWorkflowActive = true;
  });

  pi.on("session_compact", () => {
    compactionInFlight = false;
  });

  pi.on("session_compact_failed", () => {
    compactionInFlight = false;
  });

  pi.on("turn_end", (event, ctx) => {
    if (!semanticScreenWorkflowActive) return;

    const messageText = agentMessageText(event.message);
    const completed = isSemanticScreenComplete(messageText);
    const configuredThreshold = parseNonNegativeEnvInt(
      "PI_SEMANTIC_SCREEN_COMPACT_THRESHOLD",
      0,
      1_000_000,
    );
    const usage = ctx.getContextUsage();

    if (!compactionInFlight && configuredThreshold > 0 && usage?.tokens !== null && usage?.tokens !== undefined) {
      const windowAwareThreshold = Math.max(8_000, Math.floor(usage.contextWindow * 0.6));
      const effectiveThreshold = Math.min(configuredThreshold, windowAwareThreshold);
      if (usage.tokens >= effectiveThreshold) {
        compactionInFlight = true;
        ctx.compact({
          customInstructions:
            "Preserve the user's semantic-screen task, approvals, exact compact screening/review counts, confirmed findings, and resumable-state semantics. Preset primary/refinement semantics and retained IDs live in extension-owned screening state; exact review accounting lives in the extension-owned review workflow state behind screen_review_start/next/commit. Preserve primaryRunId when refinement is deferred and preserve the active workflow id if visible. Drop superseded raw evidence/source excerpts and intermediate orchestration/tool chatter. Do not invent retained/reviewed IDs, evidence coverage, blocked items, or findings.",
          onComplete: () => {
            compactionInFlight = false;
          },
          onError: () => {
            compactionInFlight = false;
          },
        });
      }
    }

    if (completed) semanticScreenWorkflowActive = false;
  });


  pi.registerTool({
    name: "screen_preset",
    label: "Semantic screen preset",
    description:
      "List semantic-screen presets or return one preset's evidence-provider selection, classifier stages, review instructions, and evidence limits.",
    promptSnippet: "Load a semantic-screen preset before discovery",
    parameters: presetParameters,
    outputSchema: presetOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(_toolCallId, params) {
      const id = (params as { id?: string }).id;
      const structuredResult = id
        ? { status: "ok" as const, preset: getPreset(id) }
        : { status: "ok" as const, presets: listPresets() };
      const text = id
        ? `screen_preset: loaded ${id}`
        : `screen_preset: ${structuredResult.presets?.map((preset) => preset.id).join(", ") ?? "none"}`;
      return {
        content: [{ type: "text", text }],
        details: {},
        structuredContent: structuredResult as unknown as JsonValue,
      };
    },
  });

  pi.registerTool({
    name: "screen_discover",
    label: "Semantic screen discovery",
    description:
      "Run deterministic candidate discovery through a preset evidence provider. Count mode returns only a count; candidates mode returns stable id/text items for screen_batch.",
    promptSnippet: "Discover semantic-screen candidates through a deterministic evidence provider",
    parameters: discoverParameters,
    outputSchema: discoverOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(_toolCallId, params, signal) {
      const request = params as { preset: string; scope: string; mode: "count" | "candidates" };
      const preset = getPreset(request.preset);
      const adapter = resolvePresetEvidenceProvider(preset);
      const result = await adapter.discover({ scope: request.scope, mode: request.mode, signal });
      const structuredResult = { ...result, preset: preset.id };
      const text =
        result.status === "ok"
          ? `screen_discover: preset=${preset.id}, mode=${request.mode}, total=${result.total}`
          : `screen_discover: preset=${preset.id} failed with ${result.issues?.length ?? 0} issue(s)`;
      return {
        content: [{ type: "text", text }],
        details: { preset: preset.id, adapter: adapter.id },
        structuredContent: structuredResult as unknown as JsonValue,
      };
    },
  });

  pi.registerTool({
    name: "screen_primary_start",
    label: "Semantic preset primary start",
    description:
      "Run a preset's exact extension-owned primary classifier contract, retain unresolved ids, and atomically start semantic review. The caller never supplies question, criteria, threshold, or reviewTargetIds.",
    promptSnippet: "Run canonical preset-owned primary screening and start review",
    parameters: primaryStartParameters,
    outputSchema: primaryStartOutputSchema,
    executionMode: "sequential",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async execute(_toolCallId, params, signal) {
      const request = params as {
        preset: string;
        scope: string;
        confirm?: boolean;
        deferReview?: boolean;
        provider?: string;
        model?: string;
        rescreen?: boolean;
      };
      const preset = getPreset(request.preset);
      const selectedClassifier = await resolveClassifierModel(await getRuntime(), {
        provider: request.provider,
        model: request.model,
        signal,
      });
      let screenedAccounting: ScreeningResult["classifierAccounting"];
      let screenedReused = false;
      const result = await presetScreeningWorkflows.startPrimary(
        {
          preset,
          scope: request.scope,
          confirm: request.confirm === true,
          deferReview: request.deferReview,
          provider: selectedClassifier.provider,
          model: selectedClassifier.id,
          rescreen: request.rescreen,
          signal,
        },
        presetWorkflowDependencies(signal, (screened) => {
          screenedAccounting = screened.result.classifierAccounting;
          screenedReused = screened.reused;
        }),
      );
      const toolUsage =
        !screenedReused && screenedAccounting?.complete && screenedAccounting.calls > 0 && screenedAccounting.usage
          ? screenedAccounting.usage
          : undefined;
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: {
          primaryRunId: result.primaryRunId ?? null,
          workflowId: result.workflowId ?? null,
          contractSource: "preset",
        },
        structuredContent: result as unknown as JsonValue,
        ...(toolUsage ? { usage: toolUsage } : {}),
      };
    },
  });

  pi.registerTool({
    name: "screen_primary_manifest",
    label: "Semantic primary outcome manifest",
    description:
      "Read the extension-owned primary classifier outcome manifest for an existing primaryRunId. Supports label filtering and pagination without rerunning discovery, classification, or review.",
    promptSnippet: "Inspect primary classifier outcomes, especially DROP candidates, for audit and observability",
    parameters: primaryManifestParameters,
    outputSchema: primaryManifestOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(_toolCallId, params) {
      const request = params as {
        primaryRunId: string;
        labels?: Array<"KEEP" | "DROP" | "UNDECIDED" | "WITHHELD" | "ERROR">;
        offset?: number;
        limit?: number;
      };
      const result = presetScreeningWorkflows.primaryManifest(request);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: {
          primaryRunId: request.primaryRunId,
          labels: result.labels,
          returned: result.returned,
        },
        structuredContent: result as unknown as JsonValue,
      };
    },
  });

  pi.registerTool({
    name: "screen_refinement_start",
    label: "Semantic preset refinement start",
    description:
      "Continue a deferred canonical primary run with the preset's exact extension-owned refinement contract, then start semantic review from the refined retained ids.",
    promptSnippet: "Run exact preset-owned refinement after an explicitly requested refinement path",
    parameters: refinementStartParameters,
    outputSchema: refinementStartOutputSchema,
    executionMode: "sequential",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async execute(_toolCallId, params, signal) {
      const request = params as { primaryRunId: string; confirm?: boolean; rescreen?: boolean };
      let screenedAccounting: ScreeningResult["classifierAccounting"];
      let screenedReused = false;
      const result = await presetScreeningWorkflows.startRefinement(
        {
          primaryRunId: request.primaryRunId,
          confirm: request.confirm === true,
          rescreen: request.rescreen,
          signal,
        },
        presetWorkflowDependencies(signal, (screened) => {
          screenedAccounting = screened.result.classifierAccounting;
          screenedReused = screened.reused;
        }),
      );
      const toolUsage =
        !screenedReused && screenedAccounting?.complete && screenedAccounting.calls > 0 && screenedAccounting.usage
          ? screenedAccounting.usage
          : undefined;
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: {
          primaryRunId: result.primaryRunId ?? null,
          workflowId: result.workflowId ?? null,
          contractSource: "preset",
        },
        structuredContent: result as unknown as JsonValue,
        ...(toolUsage ? { usage: toolUsage } : {}),
      };
    },
  });

  pi.registerTool({
    name: "screen_evidence",
    label: "Semantic screen evidence",
    description:
      "Build one deterministic bounded semantic-review evidence packet for stable candidate ids through the preset evidence provider.",
    promptSnippet: "Fetch bounded source evidence for semantic-screen review targets",
    parameters: evidenceParameters,
    outputSchema: evidenceOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(_toolCallId, params, signal) {
      const request = params as {
        preset: string;
        scope: string;
        ids: string[];
        maxItems?: number;
        maxSources?: number;
        maxChars?: number;
        maxTokens?: number;
        detail?: "standard" | "expanded";
      };
      const structuredResult = await buildEvidencePacket({ ...request, signal });
      const preset = getPreset(request.preset);
      const text =
        structuredResult.status === "ok"
          ? `screen_evidence: preset=${preset.id}, detail=${structuredResult.detail}, packet=${structuredResult.packetIds.length}/${String(structuredResult.requested ?? structuredResult.packetIds.length)}, sources=${String(structuredResult.sourceCount ?? 0)}, chars=${String(structuredResult.chars ?? 0)}, tokens~${String(structuredResult.estimatedTokens ?? 0)}/${String(structuredResult.tokenBudget ?? preset.evidence.maxTokens)}, trim=${String(structuredResult.trimReason ?? "none")}`
          : `screen_evidence: preset=${preset.id} failed`;
      return {
        content: [{ type: "text", text }],
        details: { preset: preset.id, adapter: preset.adapter },
        structuredContent: structuredResult as unknown as JsonValue,
      };
    },
  });

  pi.registerTool({
    name: "screen_review_apply",
    label: "Semantic review apply",
    description:
      "Validate exact semantic-review disposition coverage for one evidence packet and return a deterministic state delta. Makes no model, classifier, discovery, or evidence calls.",
    promptSnippet: "Validate semantic-review dispositions and compute exact review state delta",
    parameters: reviewApplyParameters,
    outputSchema: reviewApplyOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(_toolCallId, params) {
      const request = params as {
        preset: string;
        detail: "standard" | "expanded";
        packetIds: string[];
        dispositions: ReviewDecision[];
      };
      const preset = getPreset(request.preset);
      const result = applyReviewDispositions({
        packetIds: request.packetIds,
        detail: request.detail,
        dispositions: request.dispositions,
        contract: buildReviewContract(preset),
      });
      const structuredResult = { ...result, preset: preset.id };
      const text =
        result.status === "ok"
          ? `screen_review_apply: preset=${preset.id}, detail=${request.detail}, packet=${result.packetIds.length}, reviewed=${result.reviewedIds.length}, expanded=${result.needsExpandedEvidenceIds.length}, blocked=${result.blockedEvidence.length}, findings=${result.findings.length}`
          : `screen_review_apply: preset=${preset.id} rejected dispositions with ${result.issues.length} issue(s)`;
      return {
        content: [{ type: "text", text }],
        details: { preset: preset.id },
        structuredContent: structuredResult as unknown as JsonValue,
      };
    },
  });


  pi.registerTool({
    name: "screen_review_start",
    label: "Semantic review start",
    description:
      "Create an extension-owned semantic-review workflow from exact review target ids. The extension owns review accounting and queues after this point.",
    promptSnippet: "Start extension-owned semantic review state after screening",
    parameters: reviewStartParameters,
    outputSchema: reviewStartOutputSchema,
    executionMode: "sequential",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(_toolCallId, params) {
      const request = params as { preset: string; scope: string; reviewTargetIds: string[] };
      const preset = getPreset(request.preset);
      const result = reviewWorkflows.start({
        preset: preset.id,
        scope: request.scope,
        reviewTargetIds: request.reviewTargetIds,
        targetItems: preset.evidence.targetItems,
        reviewContract: buildReviewContract(preset),
      });
      if (result.status === "ok" && result.workflowId) {
        reviewPresetSnapshots.set(result.workflowId, structuredClone(preset));
      }
      const text = result.status === "ok"
        ? `screen_review_start: workflow=${result.workflowId}, preset=${preset.id}, targets=${result.progress?.reviewTarget ?? 0}`
        : `screen_review_start: failed with ${result.issues.length} issue(s)`;
      return {
        content: [{ type: "text", text }],
        details: { workflowId: result.workflowId ?? null, preset: preset.id },
        structuredContent: result as unknown as JsonValue,
      };
    },
  });

  pi.registerTool({
    name: "screen_review_next",
    label: "Semantic review next",
    description:
      "Return the exact current semantic-review evidence packet from extension-owned workflow state. Repeated calls before commit return the same pending packet. Omit workflowId to resume the latest workflow in this Pi session.",
    promptSnippet: "Fetch the next extension-owned semantic review packet",
    parameters: reviewNextParameters,
    outputSchema: reviewNextOutputSchema,
    executionMode: "sequential",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(_toolCallId, params, signal) {
      const request = params as { workflowId?: string };
      const result = await reviewWorkflows.next(request.workflowId, async (packetRequest) =>
        buildEvidencePacket({
          ...packetRequest,
          presetDefinition: reviewPresetSnapshots.get(packetRequest.workflowId),
          signal,
        }),
      );
      if (result.workflowId && (result.status === "complete" || result.status === "review_complete_with_blocked_evidence")) {
        reviewPresetSnapshots.delete(result.workflowId);
      }
      const text = JSON.stringify(result);
      return {
        content: [{ type: "text", text }],
        details: { workflowId: result.workflowId ?? null, packetId: result.packetId ?? null },
        structuredContent: result as unknown as JsonValue,
      };
    },
  });

  pi.registerTool({
    name: "screen_review_commit",
    label: "Semantic review commit",
    description:
      "Atomically validate dispositions for the current workflow packet and advance extension-owned review state. Handles reviewed/evidence-seen accounting, expanded evidence, blocked quarantine, findings, and terminal status.",
    promptSnippet: "Commit semantic dispositions atomically to extension-owned review state",
    parameters: reviewCommitParameters,
    outputSchema: reviewCommitOutputSchema,
    executionMode: "sequential",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(_toolCallId, params) {
      const request = params as {
        workflowId?: string;
        packetId: string;
        dispositions: ReviewDecisionInput[];
      };
      const result = reviewWorkflows.commit(request);
      if (result.workflowId && (result.status === "complete" || result.status === "review_complete_with_blocked_evidence")) {
        reviewPresetSnapshots.delete(result.workflowId);
      }
      const text = JSON.stringify(result);
      return {
        content: [{ type: "text", text }],
        details: { workflowId: result.workflowId ?? null, packetId: result.packetId ?? null },
        structuredContent: result as unknown as JsonValue,
      };
    },
  });

  pi.registerTool({
    name: "screen_preflight",
    label: "Semantic screen preflight",
    description:
      "Check the semantic-screen classifier call guard from a candidate count only. Makes zero classifier calls and accepts no candidate text.",
    promptSnippet: "Check semantic-screen call budget before building large candidate payloads",
    parameters: preflightParameters,
    outputSchema: preflightOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(_toolCallId, params) {
      const count = (params as { count: number }).count;
      const result = screeningPreflight(
        count,
        parsePositiveEnvInt("PI_SEMANTIC_SCREEN_CALL_LIMIT", 200, 100_000),
      );
      const text =
        result.status === "approval_required"
          ? `screen_preflight: ${result.projectedCalls} projected classifier calls exceed limit ${result.callLimit}; zero classifier calls were made.`
          : `screen_preflight: ${result.projectedCalls} projected classifier calls are within limit ${result.callLimit}; zero classifier calls were made.`;
      return {
        content: [{ type: "text", text }],
        details: {},
        structuredContent: result as unknown as JsonValue,
      };
    },
  });

  pi.registerTool({
    name: "screen_batch",
    label: "Semantic screen",
    description:
      "Batch-screen independent semantic candidates with a Pi classifier model. Returns compact typed buckets; undecided, withheld, and errors remain unresolved.",
    promptSnippet: "Batch semantic screening with a cheap classifier before deep review",
    parameters,
    outputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async execute(_toolCallId, params, signal) {
      const input = params as ScreeningInput;
      const resolved = await resolveClassifierInput(input, signal);
      const { result, reused, cacheHits, cacheMisses } = await runWithClassificationCache(
        resolved.input,
        resolved.identity,
        classificationCache,
        (missInput) => classifyBatch(missInput, createBackend(signal), {
          callLimit: parsePositiveEnvInt("PI_SEMANTIC_SCREEN_CALL_LIMIT", 200, 100_000),
          concurrency: parsePositiveEnvInt("PI_SEMANTIC_SCREEN_CONCURRENCY", 12, 64),
          contextSafetyFraction: 0.85,
          estimateTokens: estimateClassifierTokens,
          redact: redactSecrets,
          signal,
        }),
      );
      const structuredResult = { ...result, reused, cacheHits, cacheMisses };
      const accounting = result.classifierAccounting;
      const toolUsage =
        !reused && accounting?.complete && accounting.calls > 0 && accounting.usage
          ? accounting.usage
          : undefined;

      const humanSummary =
        result.status === "approval_required"
          ? `screen_batch requires confirmation: ${result.projectedCalls} classifier calls exceed limit ${result.callLimit}; zero classifier calls were made.`
          : `screen_batch: kept=${result.summary.kept}, dropped=${result.summary.dropped}, undecided=${result.summary.undecided}, withheld=${result.summary.withheld}, errors=${result.summary.errors}${result.model ? ` via ${result.model.provider}/${result.model.id}` : ""}${reused ? "; reused prior semantic classification with zero classifier calls" : `; cacheHits=${cacheHits}, cacheMisses=${cacheMisses}`}.`;

      return {
        content: [{ type: "text", text: humanSummary }],
        details: {
          classifierModel: result.model ?? null,
          classifierAccounting: accounting ?? null,
          reused,
          cacheHits,
          cacheMisses,
        },
        structuredContent: structuredResult as unknown as JsonValue,
        ...(toolUsage ? { usage: toolUsage } : {}),
      };
    },
  });
}

export {
  createBackend,
  estimateClassifierTokens,
  parameters,
  outputSchema,
  preflightParameters,
  preflightOutputSchema,
  presetParameters,
  presetOutputSchema,
  discoverParameters,
  discoverOutputSchema,
  primaryStartParameters,
  primaryStartOutputSchema,
  refinementStartParameters,
  refinementStartOutputSchema,
  evidenceParameters,
  evidenceOutputSchema,
  reviewApplyParameters,
  reviewApplyOutputSchema,
  reviewStartParameters,
  reviewStartOutputSchema,
  reviewNextParameters,
  reviewNextOutputSchema,
  reviewCommitParameters,
  reviewCommitOutputSchema,
  resolveClassifierModel,
};
