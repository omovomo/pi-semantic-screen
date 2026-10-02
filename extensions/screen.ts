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
  classifyBatch,
} from "../src/engine.ts";
import { ScreeningResultCache, runWithScreeningCache } from "../src/cache.ts";
import { screeningPreflight } from "../src/preflight.ts";
import { redactSecrets } from "../src/redaction.ts";
import { getAdapter } from "../src/adapters/registry.ts";
import { getPreset, listPresets } from "../src/presets/registry.ts";
import { boundEvidenceByTokens } from "../src/evidence-budget.ts";

const DEFAULT_PROVIDER_MODEL: readonly [string, string] = ["openrouter", "typesafe/jev-1.13"];
const PROVIDER_ORDER = ["openrouter", "typesafe", "opencode", "vercel-ai-gateway", "cloudflare-workers-ai"];

let runtimePromise: Promise<ModelRuntime> | undefined;
const resultCache = new ScreeningResultCache(4);

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
  return /semantic_screen_review_state|screen_preset|screen_discover|screen_evidence|screen_preflight|screen_batch|screen-use|screen-exceptions|screen-continue/i.test(prompt);
}

function isSemanticScreenComplete(text: string): boolean {
  return /resumeAvailable\s*[=:]\s*false|no_resumable_screen_state/i.test(text);
}

function parseEnvClassifier(): { provider: string; model: string } | undefined {
  const raw = process.env.PI_SEMANTIC_SCREEN_CLASSIFIER?.trim();
  if (!raw) return undefined;
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return undefined;
  return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
}

function rankModel(model: ClassifierModel<ClassifierApi>): [number, number, string, string] {
  const preferredExact =
    model.provider === DEFAULT_PROVIDER_MODEL[0] && model.id === DEFAULT_PROVIDER_MODEL[1] ? 0 : 1;
  const providerRank = PROVIDER_ORDER.indexOf(model.provider);
  return [preferredExact, providerRank === -1 ? PROVIDER_ORDER.length : providerRank, model.provider, model.id];
}

function compareRank(a: ClassifierModel<ClassifierApi>, b: ClassifierModel<ClassifierApi>): number {
  const ar = rankModel(a);
  const br = rankModel(b);
  for (let index = 0; index < ar.length; index += 1) {
    const av = ar[index];
    const bv = br[index];
    if (typeof av === "number" && typeof bv === "number") {
      if (av !== bv) return av - bv;
    } else {
      const cmp = String(av).localeCompare(String(bv));
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
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
    return available.sort(compareRank)[0];
  }

  if (request.model) {
    const matches = available.filter((candidate) => candidate.id === request.model).sort(compareRank);
    if (matches.length === 0) throw new Error(`classifier model id ${request.model} is not available/configured`);
    return matches[0];
  }

  const envPreference = parseEnvClassifier();
  if (envPreference) {
    const envExact = available.find(
      (candidate) => candidate.provider === envPreference.provider && candidate.id === envPreference.model,
    );
    if (envExact) return envExact;
  }

  if (available.length === 0) {
    throw new Error("no usable classifier model is available; configure classifier auth/model in Pi");
  }
  return available.sort(compareRank)[0];
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
          primary: stagePresetSchema,
          refinement: Type.Optional(stagePresetSchema),
          review: Type.Object(
            { instructions: Type.String(), confirmWhen: Type.String() },
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
          { id: Type.String(), text: Type.String() },
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
  },
  { additionalProperties: false },
);

const evidenceOutputSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ok"), Type.Literal("error")]),
    adapter: Type.String(),
    preset: Type.String(),
    scope: Type.String(),
    requested: Type.Integer({ minimum: 0 }),
    packetIds: Type.Array(Type.String()),
    sourceCount: Type.Integer({ minimum: 0 }),
    chars: Type.Integer({ minimum: 0 }),
    tokenBudget: Type.Integer({ minimum: 1 }),
    estimatedTokens: Type.Integer({ minimum: 0 }),
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
      Type.Number({ exclusiveMinimum: 0.5, maximum: 1, description: "Default 0.70" }),
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

export default function semanticScreenExtension(pi: ExtensionAPI) {
  let semanticScreenWorkflowActive = false;
  let compactionInFlight = false;

  pi.on("session_start", () => {
    semanticScreenWorkflowActive = false;
    compactionInFlight = false;
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
            "Preserve the user's semantic-screen task, approvals, exact compact screening/review counts, confirmed findings, and resumable-state semantics. Exact review accounting lives in Code Mode store key semantic_screen_review_state. Drop superseded raw evidence/source excerpts and intermediate orchestration/tool chatter. Do not invent reviewed IDs, evidence coverage, or findings.",
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
      "List semantic-screen presets or return one preset's adapter, classifier stages, review instructions, and evidence limits.",
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
      "Run deterministic candidate discovery through a preset adapter. Count mode returns only a count; candidates mode returns stable id/text items for screen_batch.",
    promptSnippet: "Discover semantic-screen candidates through a deterministic adapter",
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
      const adapter = getAdapter(preset.adapter);
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
    name: "screen_evidence",
    label: "Semantic screen evidence",
    description:
      "Build one deterministic bounded semantic-review evidence packet for stable candidate ids through the preset adapter.",
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
      };
      const preset = getPreset(request.preset);
      const adapter = getAdapter(preset.adapter);
      const result = await adapter.evidence({
        scope: request.scope,
        ids: request.ids,
        maxItems: request.maxItems ?? preset.evidence.maxItems,
        maxSources: request.maxSources ?? preset.evidence.maxSources,
        maxChars: request.maxChars ?? preset.evidence.maxChars,
        signal,
      });
      const bounded = boundEvidenceByTokens(
        result,
        request.maxTokens ?? preset.evidence.maxTokens,
        estimateClassifierTokens,
        { preset: preset.id },
      );
      const structuredResult = { ...bounded, preset: preset.id };
      const text =
        bounded.status === "ok"
          ? `screen_evidence: preset=${preset.id}, packet=${bounded.packetIds.length}/${bounded.requested}, sources=${bounded.sourceCount}, chars=${bounded.chars}, tokens~${bounded.estimatedTokens}/${bounded.tokenBudget}`
          : `screen_evidence: preset=${preset.id} failed with ${bounded.issues?.length ?? 0} issue(s)`;
      return {
        content: [{ type: "text", text }],
        details: { preset: preset.id, adapter: adapter.id },
        structuredContent: structuredResult as unknown as JsonValue,
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
      const { result, reused } = await runWithScreeningCache(input, resultCache, () =>
        classifyBatch(input, createBackend(signal), {
          callLimit: parsePositiveEnvInt("PI_SEMANTIC_SCREEN_CALL_LIMIT", 200, 100_000),
          concurrency: parsePositiveEnvInt("PI_SEMANTIC_SCREEN_CONCURRENCY", 12, 64),
          contextSafetyFraction: 0.85,
          estimateTokens: estimateClassifierTokens,
          redact: redactSecrets,
          signal,
        }),
      );
      const structuredResult = { ...result, reused };
      const accounting = result.classifierAccounting;
      const toolUsage =
        !reused && accounting?.complete && accounting.calls > 0 && accounting.usage
          ? accounting.usage
          : undefined;

      const humanSummary =
        result.status === "approval_required"
          ? `screen_batch requires confirmation: ${result.projectedCalls} classifier calls exceed limit ${result.callLimit}; zero classifier calls were made.`
          : `screen_batch: kept=${result.summary.kept}, dropped=${result.summary.dropped}, undecided=${result.summary.undecided}, withheld=${result.summary.withheld}, errors=${result.summary.errors}${result.model ? ` via ${result.model.provider}/${result.model.id}` : ""}${reused ? "; reused prior successful screening with zero classifier calls" : ""}.`;

      return {
        content: [{ type: "text", text: humanSummary }],
        details: {
          classifierModel: result.model ?? null,
          classifierAccounting: accounting ?? null,
          reused,
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
  evidenceParameters,
  evidenceOutputSchema,
  resolveClassifierModel,
};
