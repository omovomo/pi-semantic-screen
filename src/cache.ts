import {
  DEFAULT_CRITERIA,
  resolveScreeningThresholds,
  type ScreeningInput,
  type ScreeningResult,
} from "./engine.ts";

export interface CachedScreeningResult {
  result: ScreeningResult;
  reused: boolean;
}

export async function fingerprintScreeningInput(input: ScreeningInput): Promise<string> {
  const thresholds = resolveScreeningThresholds(input);
  const payload = JSON.stringify({
    items: input.items.map((item) => [item.id, item.text]),
    question: input.question,
    criteria: input.criteria ?? DEFAULT_CRITERIA,
    keepThreshold: thresholds.keepThreshold,
    dropThreshold: thresholds.dropThreshold,
    provider: input.provider ?? null,
    model: input.model ?? null,
    confirm: input.confirm ?? false,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class ScreeningResultCache {
  private readonly entries = new Map<string, ScreeningResult>();
  private readonly maxEntries: number;

  constructor(maxEntries = 4) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("maxEntries must be a positive integer");
    }
    this.maxEntries = maxEntries;
  }

  get(key: string): ScreeningResult | undefined {
    const value = this.entries.get(key);
    if (!value) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return structuredClone(value);
  }

  set(key: string, result: ScreeningResult): void {
    if (result.status !== "ok") return;
    this.entries.delete(key);
    this.entries.set(key, structuredClone(result));
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

export async function runWithScreeningCache(
  input: ScreeningInput,
  cache: ScreeningResultCache,
  run: () => Promise<ScreeningResult>,
): Promise<CachedScreeningResult> {
  const key = await fingerprintScreeningInput(input);
  if (input.rescreen !== true) {
    const cached = cache.get(key);
    if (cached) return { result: cached, reused: true };
  }

  const result = await run();
  cache.set(key, result);
  return { result, reused: false };
}

export const CLASSIFICATION_CACHE_SCHEMA = "semantic-classification-v1";

export interface ClassifierIdentity {
  provider: string;
  id: string;
  implementation?: string;
}

export interface ClassificationCacheRun {
  result: ScreeningResult;
  reused: boolean;
  cacheHits: number;
  cacheMisses: number;
}

type SemanticBucket = "kept" | "dropped" | "undecided";

interface CachedSemanticOutcome {
  bucket: SemanticBucket;
  probability: number;
}

async function sha256(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function fingerprintClassifierContract(
  input: ScreeningInput,
  identity: ClassifierIdentity,
): Promise<string> {
  const thresholds = resolveScreeningThresholds(input);
  return sha256(JSON.stringify({
    schema: CLASSIFICATION_CACHE_SCHEMA,
    question: input.question,
    criteria: input.criteria ?? DEFAULT_CRITERIA,
    keepThreshold: thresholds.keepThreshold,
    dropThreshold: thresholds.dropThreshold,
    classifier: {
      provider: identity.provider,
      id: identity.id,
      implementation: identity.implementation ?? "pi-classifier",
    },
  }));
}

export async function fingerprintCandidate(item: ScreeningInput["items"][number]): Promise<string> {
  const normalizedText = item.text.replace(/\r\n?/g, "\n");
  return sha256(JSON.stringify({ id: item.id, text: normalizedText }));
}

export class ClassificationResultCache {
  private readonly entries = new Map<string, CachedSemanticOutcome>();
  private readonly maxEntries: number;

  constructor(maxEntries = 50_000) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be a positive integer");
    this.maxEntries = maxEntries;
  }

  get(key: string): CachedSemanticOutcome | undefined {
    const value = this.entries.get(key);
    if (!value) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return { ...value };
  }

  set(key: string, outcome: CachedSemanticOutcome): void {
    this.entries.delete(key);
    this.entries.set(key, { ...outcome });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

function semanticOutcomeMap(result: ScreeningResult): Map<string, CachedSemanticOutcome> {
  const outcomes = new Map<string, CachedSemanticOutcome>();
  for (const item of result.kept) outcomes.set(item.id, { bucket: "kept", probability: item.probability });
  for (const item of result.dropped) outcomes.set(item.id, { bucket: "dropped", probability: item.probability });
  for (const item of result.undecided) outcomes.set(item.id, { bucket: "undecided", probability: item.probability });
  return outcomes;
}

function emptyAccounting() {
  return { calls: 0, usageReportedCalls: 0, complete: true } as const;
}

function mergeCachedAndFresh(
  input: ScreeningInput,
  identity: ClassifierIdentity,
  cached: Map<string, CachedSemanticOutcome>,
  fresh: ScreeningResult | undefined,
): ScreeningResult {
  const freshSemantic = fresh ? semanticOutcomeMap(fresh) : new Map<string, CachedSemanticOutcome>();
  const freshWithheld = new Map((fresh?.withheld ?? []).map((item) => [item.id, item]));
  const freshErrors = new Map((fresh?.errors ?? []).map((item) => [item.id, item]));
  const kept: ScreeningResult["kept"] = [];
  const dropped: ScreeningResult["dropped"] = [];
  const undecided: ScreeningResult["undecided"] = [];
  const withheld: ScreeningResult["withheld"] = [];
  const errors: ScreeningResult["errors"] = [];

  for (const item of input.items) {
    const semantic = cached.get(item.id) ?? freshSemantic.get(item.id);
    if (semantic) {
      const entry = { id: item.id, probability: semantic.probability };
      if (semantic.bucket === "kept") kept.push(entry);
      else if (semantic.bucket === "dropped") dropped.push(entry);
      else undecided.push(entry);
      continue;
    }
    const held = freshWithheld.get(item.id);
    if (held) {
      withheld.push(held);
      continue;
    }
    const error = freshErrors.get(item.id);
    if (error) {
      errors.push(error);
      continue;
    }
    throw new Error(`classification cache merge missing result for candidate ${item.id}`);
  }

  const status = fresh?.status ?? "ok";
  return {
    status,
    model: { provider: identity.provider, id: identity.id },
    summary: {
      total: input.items.length,
      kept: kept.length,
      dropped: dropped.length,
      undecided: undecided.length,
      withheld: withheld.length,
      errors: errors.length,
      redactedItems: fresh?.summary.redactedItems ?? 0,
      redactionCount: fresh?.summary.redactionCount ?? 0,
    },
    kept,
    dropped,
    undecided,
    withheld,
    errors,
    ...(fresh?.projectedCalls === undefined ? {} : { projectedCalls: fresh.projectedCalls }),
    ...(fresh?.callLimit === undefined ? {} : { callLimit: fresh.callLimit }),
    classifierAccounting: fresh?.classifierAccounting ?? emptyAccounting(),
  };
}

/**
 * Per-candidate semantic classification reuse. Keys deliberately separate the
 * classifier contract/identity from the normalized candidate fingerprint.
 * Only successful KEEP/DROP/UNDECIDED outcomes are cached; withheld/errors are
 * recomputed on the next run. Review results are intentionally not cached here.
 */
export async function runWithClassificationCache(
  input: ScreeningInput,
  identity: ClassifierIdentity,
  cache: ClassificationResultCache,
  run: (missInput: ScreeningInput) => Promise<ScreeningResult>,
): Promise<ClassificationCacheRun> {
  const contract = await fingerprintClassifierContract(input, identity);
  const cachedById = new Map<string, CachedSemanticOutcome>();
  const misses: ScreeningInput["items"] = [];
  const cacheKeys = new Map<string, string>();

  for (const item of input.items) {
    const candidate = await fingerprintCandidate(item);
    const key = `${contract}:${candidate}`;
    cacheKeys.set(item.id, key);
    const hit = input.rescreen === true ? undefined : cache.get(key);
    if (hit) cachedById.set(item.id, hit);
    else misses.push(item);
  }

  if (misses.length === 0) {
    return {
      result: mergeCachedAndFresh(input, identity, cachedById, undefined),
      reused: true,
      cacheHits: input.items.length,
      cacheMisses: 0,
    };
  }

  const missInput: ScreeningInput = {
    ...input,
    items: misses,
    provider: identity.provider,
    model: identity.id,
  };
  const fresh = await run(missInput);
  const freshOutcomes = semanticOutcomeMap(fresh);
  if (fresh.status === "ok") {
    for (const [id, outcome] of freshOutcomes) {
      const key = cacheKeys.get(id);
      if (key) cache.set(key, outcome);
    }
  }

  return {
    result: mergeCachedAndFresh(input, identity, cachedById, fresh),
    reused: cachedById.size === input.items.length,
    cacheHits: cachedById.size,
    cacheMisses: misses.length,
  };
}
