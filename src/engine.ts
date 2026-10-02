export interface ScreeningItem {
  id: string;
  text: string;
}

export interface ScreeningCriteria {
  true: string;
  false: string;
}

export interface ScreeningInput {
  items: ScreeningItem[];
  question: string;
  criteria?: ScreeningCriteria;
  threshold?: number;
  provider?: string;
  model?: string;
  confirm?: boolean;
  rescreen?: boolean;
}

export interface ClassifierModelRef {
  provider: string;
  id: string;
  contextWindow: number;
}

export interface BoolClassifierAnswer {
  type: "bool";
  probability: number;
}

export interface ClassifierUsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface ClassifierResultLike {
  stopReason: string;
  errorMessage?: string;
  answers?: Record<string, unknown>;
  /** Optional in older Pi classifier runtimes; System One providers in newer Pi versions report it. */
  usage?: ClassifierUsageLike;
}

export interface ClassifierContextLike {
  state: {
    id: string;
    text: string;
  };
  questions: {
    keep: {
      type: "bool";
      instructions: string;
      criteria: ScreeningCriteria;
    };
  };
}

export interface ClassifierBackend {
  selectModel(request: {
    provider?: string;
    model?: string;
    signal?: AbortSignal;
  }): Promise<ClassifierModelRef>;
  classify(
    model: ClassifierModelRef,
    context: ClassifierContextLike,
    options: { signal?: AbortSignal },
  ): Promise<ClassifierResultLike>;
}

export interface RedactionResult {
  text: string;
  count: number;
}

export interface ScreeningEngineOptions {
  callLimit?: number;
  concurrency?: number;
  contextSafetyFraction?: number;
  estimateTokens: (text: string) => number;
  redact: (text: string) => RedactionResult;
  signal?: AbortSignal;
}

export interface ProbabilityItem {
  id: string;
  probability: number;
}

export interface WithheldItem {
  id: string;
  reason: "too_large" | "approval_required";
}

export interface ErrorItem {
  id: string;
  reason:
    | "classifier_error"
    | "classifier_exception"
    | "malformed_answer"
    | "aborted"
    | "model_unavailable";
  message?: string;
}

export interface ScreeningSummary {
  total: number;
  kept: number;
  dropped: number;
  undecided: number;
  withheld: number;
  errors: number;
  redactedItems: number;
  redactionCount: number;
}

export interface ClassifierAccounting {
  calls: number;
  usageReportedCalls: number;
  complete: boolean;
  usage?: ClassifierUsageLike;
}

export interface ScreeningResult {
  status: "ok" | "approval_required" | "error";
  model?: {
    provider: string;
    id: string;
  };
  summary: ScreeningSummary;
  kept: ProbabilityItem[];
  dropped: ProbabilityItem[];
  undecided: ProbabilityItem[];
  withheld: WithheldItem[];
  errors: ErrorItem[];
  projectedCalls?: number;
  callLimit?: number;
  classifierAccounting?: ClassifierAccounting;
}

export const DEFAULT_CRITERIA: ScreeningCriteria = {
  true: "The item should be retained for deeper review.",
  false: "The item can be safely excluded from deeper review.",
};

export const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_CALL_LIMIT = 200;
const DEFAULT_CONCURRENCY = 12;
const DEFAULT_CONTEXT_SAFETY_FRACTION = 0.85;

function validateInput(input: ScreeningInput): void {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error("items must contain at least one item");
  }
  if (typeof input.question !== "string" || input.question.trim().length === 0) {
    throw new Error("question must be a non-empty string");
  }

  const seen = new Set<string>();
  for (const item of input.items) {
    if (!item || typeof item.id !== "string" || item.id.length === 0) {
      throw new Error("every item must have a non-empty string id");
    }
    if (typeof item.text !== "string") {
      throw new Error(`item ${item.id} must have string text`);
    }
    if (seen.has(item.id)) {
      throw new Error(`duplicate item id: ${item.id}`);
    }
    seen.add(item.id);
  }

  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold <= 0.5 || threshold > 1) {
    throw new Error("threshold must be > 0.5 and <= 1");
  }

  if (input.criteria) {
    if (typeof input.criteria.true !== "string" || input.criteria.true.trim().length === 0) {
      throw new Error("criteria.true must be a non-empty string");
    }
    if (typeof input.criteria.false !== "string" || input.criteria.false.trim().length === 0) {
      throw new Error("criteria.false must be a non-empty string");
    }
  }
  if (input.provider !== undefined && input.provider.trim().length === 0) {
    throw new Error("provider must be non-empty when provided");
  }
  if (input.model !== undefined && input.model.trim().length === 0) {
    throw new Error("model must be non-empty when provided");
  }
  if (input.rescreen !== undefined && typeof input.rescreen !== "boolean") {
    throw new Error("rescreen must be boolean when provided");
  }
}

function safeMessage(error: unknown, redact: (text: string) => RedactionResult): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redact(raw.slice(0, 500)).text.slice(0, 500);
}

function safeResultMessage(
  message: string | undefined,
  fallback: string,
  itemText: string,
  redact: (text: string) => RedactionResult,
): string {
  let safe = redact((message ?? fallback).slice(0, 500)).text.slice(0, 500);
  for (const candidate of [itemText, redact(itemText).text]) {
    if (candidate.length > 0 && candidate.length <= 500 && safe.includes(candidate)) {
      safe = safe.replaceAll(candidate, "[ITEM_TEXT_REDACTED]");
    }
  }
  return safe;
}

function makeSummary(
  total: number,
  kept: number,
  dropped: number,
  undecided: number,
  withheld: number,
  errors: number,
  redactedItems: number,
  redactionCount: number,
): ScreeningSummary {
  return { total, kept, dropped, undecided, withheld, errors, redactedItems, redactionCount };
}

function addClassifierUsage(
  current: ClassifierUsageLike | undefined,
  next: ClassifierUsageLike,
): ClassifierUsageLike {
  const base = current ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const cacheWrite1h = (base.cacheWrite1h ?? 0) + (next.cacheWrite1h ?? 0);
  const reasoning = (base.reasoning ?? 0) + (next.reasoning ?? 0);
  return {
    input: base.input + next.input,
    output: base.output + next.output,
    cacheRead: base.cacheRead + next.cacheRead,
    cacheWrite: base.cacheWrite + next.cacheWrite,
    ...(base.cacheWrite1h !== undefined || next.cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
    ...(base.reasoning !== undefined || next.reasoning !== undefined ? { reasoning } : {}),
    totalTokens: base.totalTokens + next.totalTokens,
    cost: {
      input: base.cost.input + next.cost.input,
      output: base.cost.output + next.cost.output,
      cacheRead: base.cost.cacheRead + next.cost.cacheRead,
      cacheWrite: base.cost.cacheWrite + next.cost.cacheWrite,
      total: base.cost.total + next.cost.total,
    },
  };
}

function assertAccounting(result: ScreeningResult, inputIds: readonly string[]): void {
  const buckets: Array<readonly { id: string }[]> = [
    result.kept,
    result.dropped,
    result.undecided,
    result.withheld,
    result.errors,
  ];
  const seen = new Set<string>();

  for (const bucket of buckets) {
    for (const item of bucket) {
      if (seen.has(item.id)) throw new Error(`accounting invariant violated: duplicate result id ${item.id}`);
      seen.add(item.id);
    }
  }

  if (seen.size !== inputIds.length) {
    throw new Error(`accounting invariant violated: expected ${inputIds.length} ids, got ${seen.size}`);
  }
  for (const id of inputIds) {
    if (!seen.has(id)) throw new Error(`accounting invariant violated: missing result id ${id}`);
  }

  const counted =
    result.summary.kept +
    result.summary.dropped +
    result.summary.undecided +
    result.summary.withheld +
    result.summary.errors;
  if (result.summary.total !== counted || result.summary.total !== inputIds.length) {
    throw new Error(
      `accounting invariant violated: total=${result.summary.total}, buckets=${counted}, inputs=${inputIds.length}`,
    );
  }
}

function buildContext(
  id: string,
  text: string,
  question: string,
  criteria: ScreeningCriteria,
): ClassifierContextLike {
  return {
    state: { id, text },
    questions: {
      keep: {
        type: "bool",
        instructions: question,
        criteria,
      },
    },
  };
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abortListener, { once: true });
  });

  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
    void promise.catch(() => undefined);
  }
}

export async function classifyBatch(
  input: ScreeningInput,
  backend: ClassifierBackend,
  options: ScreeningEngineOptions,
): Promise<ScreeningResult> {
  validateInput(input);

  const callLimit = options.callLimit ?? DEFAULT_CALL_LIMIT;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const contextSafetyFraction = options.contextSafetyFraction ?? DEFAULT_CONTEXT_SAFETY_FRACTION;
  if (!Number.isInteger(callLimit) || callLimit < 1) throw new Error("callLimit must be a positive integer");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new Error("concurrency must be an integer in 1..64");
  }
  if (!Number.isFinite(contextSafetyFraction) || contextSafetyFraction <= 0 || contextSafetyFraction >= 1) {
    throw new Error("contextSafetyFraction must be > 0 and < 1");
  }

  const inputIds = input.items.map((item) => item.id);
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const criteria = input.criteria ?? DEFAULT_CRITERIA;

  if (input.items.length > callLimit && input.confirm !== true) {
    const withheld = input.items.map((item) => ({ id: item.id, reason: "approval_required" as const }));
    const result: ScreeningResult = {
      status: "approval_required",
      summary: makeSummary(input.items.length, 0, 0, 0, withheld.length, 0, 0, 0),
      kept: [],
      dropped: [],
      undecided: [],
      withheld,
      errors: [],
      projectedCalls: input.items.length,
      callLimit,
    };
    assertAccounting(result, inputIds);
    return result;
  }

  if (options.signal?.aborted) {
    const errors = input.items.map((item) => ({
      id: item.id,
      reason: "aborted" as const,
      message: "aborted before classifier model selection",
    }));
    const result: ScreeningResult = {
      status: "error",
      summary: makeSummary(input.items.length, 0, 0, 0, 0, errors.length, 0, 0),
      kept: [],
      dropped: [],
      undecided: [],
      withheld: [],
      errors,
    };
    assertAccounting(result, inputIds);
    return result;
  }

  let model: ClassifierModelRef;
  try {
    model = await backend.selectModel({
      provider: input.provider,
      model: input.model,
      signal: options.signal,
    });
  } catch (error) {
    const aborted = options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError");
    const message = safeMessage(error, options.redact);
    const errors = input.items.map((item) => ({
      id: item.id,
      reason: aborted ? ("aborted" as const) : ("model_unavailable" as const),
      message,
    }));
    const result: ScreeningResult = {
      status: "error",
      summary: makeSummary(input.items.length, 0, 0, 0, 0, errors.length, 0, 0),
      kept: [],
      dropped: [],
      undecided: [],
      withheld: [],
      errors,
    };
    assertAccounting(result, inputIds);
    return result;
  }

  const terminal = new Map<
    string,
    | { bucket: "kept" | "dropped" | "undecided"; probability: number }
    | { bucket: "withheld"; reason: WithheldItem["reason"] }
    | { bucket: "errors"; reason: ErrorItem["reason"]; message?: string }
  >();

  let redactedItems = 0;
  let redactionCount = 0;

  // Everything sent to a remote classifier is caller-supplied, but redact all textual
  // fields in that payload rather than treating only items[].text as sensitive.
  const redactedQuestion = options.redact(input.question);
  const redactedTrueCriterion = options.redact(criteria.true);
  const redactedFalseCriterion = options.redact(criteria.false);
  redactionCount += redactedQuestion.count + redactedTrueCriterion.count + redactedFalseCriterion.count;
  const redactedCriteria: ScreeningCriteria = {
    true: redactedTrueCriterion.text,
    false: redactedFalseCriterion.text,
  };

  const prepared: Array<{ item: ScreeningItem; context: ClassifierContextLike }> = [];
  const maxInputTokens = Math.max(1, Math.floor(model.contextWindow * contextSafetyFraction));

  for (const item of input.items) {
    const redacted = options.redact(item.text);
    if (redacted.count > 0) {
      redactedItems += 1;
      redactionCount += redacted.count;
    }
    const context = buildContext(item.id, redacted.text, redactedQuestion.text, redactedCriteria);
    const estimatedTokens = options.estimateTokens(JSON.stringify(context));
    if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0) {
      throw new Error("estimateTokens must return a finite non-negative number");
    }
    if (estimatedTokens > maxInputTokens) {
      terminal.set(item.id, { bucket: "withheld", reason: "too_large" });
      continue;
    }
    prepared.push({ item, context });
  }

  let nextIndex = 0;
  let classifierCalls = 0;
  let usageReportedCalls = 0;
  let classifierUsage: ClassifierUsageLike | undefined;
  // Internal engine option only; this is not part of the model-visible tool input contract.
  const optionsSignal = options.signal;
  const worker = async () => {
    while (true) {
      if (optionsSignal?.aborted) return;
      const current = nextIndex++;
      if (current >= prepared.length) return;
      const { item, context } = prepared[current];

      try {
        classifierCalls += 1;
        const call = backend.classify(model, context, { signal: optionsSignal });
        const response = await withAbort(call, optionsSignal);
        if (response.usage) {
          usageReportedCalls += 1;
          classifierUsage = addClassifierUsage(classifierUsage, response.usage);
        }

        if (response.stopReason === "aborted") {
          terminal.set(item.id, {
            bucket: "errors",
            reason: "aborted",
            message: safeResultMessage(response.errorMessage, "classifier aborted", context.state.text, options.redact),
          });
          continue;
        }
        if (response.stopReason !== "stop") {
          terminal.set(item.id, {
            bucket: "errors",
            reason: "classifier_error",
            message: safeResultMessage(
              response.errorMessage,
              `stopReason=${response.stopReason}`,
              context.state.text,
              options.redact,
            ),
          });
          continue;
        }

        const answer = response.answers?.keep as Partial<BoolClassifierAnswer> | undefined;
        if (
          !answer ||
          answer.type !== "bool" ||
          typeof answer.probability !== "number" ||
          !Number.isFinite(answer.probability) ||
          answer.probability < 0 ||
          answer.probability > 1
        ) {
          terminal.set(item.id, {
            bucket: "errors",
            reason: "malformed_answer",
            message: "missing or invalid bool answer",
          });
          continue;
        }

        if (answer.probability >= threshold) {
          terminal.set(item.id, { bucket: "kept", probability: answer.probability });
        } else if (answer.probability <= 1 - threshold) {
          terminal.set(item.id, { bucket: "dropped", probability: answer.probability });
        } else {
          terminal.set(item.id, { bucket: "undecided", probability: answer.probability });
        }
      } catch (error) {
        const aborted = optionsSignal?.aborted || (error instanceof DOMException && error.name === "AbortError");
        terminal.set(item.id, {
          bucket: "errors",
          reason: aborted ? "aborted" : "classifier_exception",
          message: safeResultMessage(
            safeMessage(error, options.redact),
            "classifier exception",
            context.state.text,
            options.redact,
          ),
        });
        if (aborted) return;
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, prepared.length) }, () => worker());
  await Promise.all(workers);

  if (optionsSignal?.aborted) {
    for (const entry of prepared) {
      if (!terminal.has(entry.item.id)) {
        terminal.set(entry.item.id, { bucket: "errors", reason: "aborted", message: "aborted before classification" });
      }
    }
  }

  const kept: ProbabilityItem[] = [];
  const dropped: ProbabilityItem[] = [];
  const undecided: ProbabilityItem[] = [];
  const withheld: WithheldItem[] = [];
  const errors: ErrorItem[] = [];

  for (const item of input.items) {
    const value = terminal.get(item.id);
    if (!value) {
      errors.push({ id: item.id, reason: "classifier_exception", message: "classification did not produce a result" });
      continue;
    }
    switch (value.bucket) {
      case "kept":
        kept.push({ id: item.id, probability: value.probability });
        break;
      case "dropped":
        dropped.push({ id: item.id, probability: value.probability });
        break;
      case "undecided":
        undecided.push({ id: item.id, probability: value.probability });
        break;
      case "withheld":
        withheld.push({ id: item.id, reason: value.reason });
        break;
      case "errors":
        errors.push({ id: item.id, reason: value.reason, ...(value.message ? { message: value.message } : {}) });
        break;
    }
  }

  const result: ScreeningResult = {
    status: errors.length > 0 && kept.length + dropped.length + undecided.length + withheld.length === 0 ? "error" : "ok",
    model: { provider: model.provider, id: model.id },
    summary: makeSummary(
      input.items.length,
      kept.length,
      dropped.length,
      undecided.length,
      withheld.length,
      errors.length,
      redactedItems,
      redactionCount,
    ),
    kept,
    dropped,
    undecided,
    withheld,
    errors,
    classifierAccounting: {
      calls: classifierCalls,
      usageReportedCalls,
      complete: classifierCalls === usageReportedCalls,
      ...(classifierUsage ? { usage: classifierUsage } : {}),
    },
  };
  assertAccounting(result, inputIds);
  return result;
}
