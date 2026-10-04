import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { GenericSourcePattern, GenericSourceProviderConfig } from "../providers/generic-source.ts";
import type { EvidenceProviderSpec } from "../providers/spec.ts";
import type { ScreeningPreset, ScreeningStagePreset } from "./types.ts";

export const SIMPLE_PRESET_DEFAULTS_VERSION = 1;

const SIMPLE_PRIMARY_THRESHOLD = 0.70;
const SIMPLE_EVIDENCE_DEFAULTS = {
  targetItems: 40,
  maxItems: 60,
  maxSources: 10,
  maxChars: 120_000,
  maxTokens: 7_200,
} as const;
const SIMPLE_SOURCE_DEFAULTS = {
  candidate: { beforeLines: 1, afterLines: 5, maxChars: 3_500 },
  standard: { beforeLines: 5, afterLines: 16, maxChars: 12_000 },
  expanded: { beforeLines: 16, afterLines: 48, maxChars: 28_000 },
  limits: { maxFiles: 10_000, maxFileBytes: 1_000_000, maxCandidates: 100_000 },
} as const;

function object(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, where: string): string | undefined {
  return value === undefined ? undefined : string(value, where);
}

function number(value: unknown, where: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${where} must be a number in [${min}, ${max}]`);
  }
  return value;
}

function integer(value: unknown, where: string, min: number, max: number): number {
  const parsed = number(value, where, min, max);
  if (!Number.isInteger(parsed)) throw new Error(`${where} must be an integer`);
  return parsed;
}

function stage(value: unknown, where: string): ScreeningStagePreset {
  const input = object(value, where);
  const criteria = object(input.criteria, `${where}.criteria`);
  return {
    question: string(input.question, `${where}.question`),
    criteria: {
      true: string(criteria.true, `${where}.criteria.true`),
      false: string(criteria.false, `${where}.criteria.false`),
    },
    threshold: number(input.threshold, `${where}.threshold`, 0.5, 1),
  };
}

function stringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${where} must be a non-empty string array`);
  return value.map((item, index) => string(item, `${where}[${index}]`));
}

function optionalStringArray(value: unknown, where: string): string[] | undefined {
  return value === undefined ? undefined : stringArray(value, where);
}

function simpleDropHints(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  const hints = stringArray(value, where);
  if (hints.length > 8) throw new Error(`${where} must contain at most 8 hints`);
  for (const [index, hint] of hints.entries()) {
    if (hint.length > 240) throw new Error(`${where}[${index}] must be at most 240 characters`);
  }
  return hints;
}

function genericSourceConfig(value: unknown, where: string): GenericSourceProviderConfig {
  const input = object(value, where);
  if (!Array.isArray(input.patterns) || input.patterns.length === 0) throw new Error(`${where}.patterns must be non-empty`);
  const patterns = input.patterns.map((entry, index) => {
    const pattern = object(entry, `${where}.patterns[${index}]`);
    return {
      id: string(pattern.id, `${where}.patterns[${index}].id`),
      regex: string(pattern.regex, `${where}.patterns[${index}].regex`),
      ...(pattern.flags === undefined ? {} : { flags: string(pattern.flags, `${where}.patterns[${index}].flags`) }),
      ...(pattern.label === undefined ? {} : { label: string(pattern.label, `${where}.patterns[${index}].label`) }),
    };
  });

  const parseWindow = (entry: unknown, at: string) => {
    if (entry === undefined) return undefined;
    const source = object(entry, at);
    return {
      ...(source.beforeLines === undefined ? {} : { beforeLines: integer(source.beforeLines, `${at}.beforeLines`, 0, 500) }),
      ...(source.afterLines === undefined ? {} : { afterLines: integer(source.afterLines, `${at}.afterLines`, 0, 500) }),
      ...(source.maxChars === undefined ? {} : { maxChars: integer(source.maxChars, `${at}.maxChars`, 1, 200_000) }),
    };
  };

  const evidenceInput = input.evidence === undefined ? undefined : object(input.evidence, `${where}.evidence`);
  const limitsInput = input.limits === undefined ? undefined : object(input.limits, `${where}.limits`);
  return {
    include: stringArray(input.include, `${where}.include`),
    ...(input.exclude === undefined ? {} : { exclude: stringArray(input.exclude, `${where}.exclude`) }),
    patterns,
    ...(input.candidate === undefined ? {} : { candidate: parseWindow(input.candidate, `${where}.candidate`) }),
    ...(evidenceInput === undefined
      ? {}
      : {
          evidence: {
            ...(evidenceInput.standard === undefined ? {} : { standard: parseWindow(evidenceInput.standard, `${where}.evidence.standard`) }),
            ...(evidenceInput.expanded === undefined ? {} : { expanded: parseWindow(evidenceInput.expanded, `${where}.evidence.expanded`) }),
          },
        }),
    ...(limitsInput === undefined
      ? {}
      : {
          limits: {
            ...(limitsInput.maxFiles === undefined ? {} : { maxFiles: integer(limitsInput.maxFiles, `${where}.limits.maxFiles`, 1, 100_000) }),
            ...(limitsInput.maxFileBytes === undefined ? {} : { maxFileBytes: integer(limitsInput.maxFileBytes, `${where}.limits.maxFileBytes`, 1, 20_000_000) }),
            ...(limitsInput.maxCandidates === undefined ? {} : { maxCandidates: integer(limitsInput.maxCandidates, `${where}.limits.maxCandidates`, 1, 1_000_000) }),
          },
        }),
  };
}

function provider(value: unknown): { spec: EvidenceProviderSpec; adapter: string } {
  const input = object(value, "provider");
  const kind = string(input.kind, "provider.kind");
  if (kind === "builtin") {
    const id = string(input.id, "provider.id");
    return { spec: { kind: "builtin", id }, adapter: id };
  }
  if (kind === "generic-source") {
    return { spec: { kind: "generic-source", config: genericSourceConfig(input.config, "provider.config") }, adapter: "generic-source" };
  }
  throw new Error(`provider.kind is unsupported: ${kind}`);
}

function simplePattern(value: unknown, index: number, where: string): GenericSourcePattern {
  if (typeof value === "string") {
    return { id: `match-${index + 1}`, regex: string(value, `${where}[${index}]`) };
  }
  const entry = object(value, `${where}[${index}]`);
  return {
    id: optionalString(entry.id, `${where}[${index}].id`) ?? `match-${index + 1}`,
    regex: string(entry.regex, `${where}[${index}].regex`),
    ...(entry.flags === undefined ? {} : { flags: string(entry.flags, `${where}[${index}].flags`) }),
    ...(entry.label === undefined ? {} : { label: string(entry.label, `${where}[${index}].label`) }),
  };
}

function simpleSource(value: unknown, where: string): GenericSourceProviderConfig {
  const input = object(value, where);
  if (!Array.isArray(input.match) || input.match.length === 0) throw new Error(`${where}.match must be a non-empty array`);
  const exclude = optionalStringArray(input.exclude, `${where}.exclude`);
  return {
    include: stringArray(input.include, `${where}.include`),
    ...(exclude ? { exclude } : {}),
    patterns: input.match.map((entry, index) => simplePattern(entry, index, `${where}.match`)),
    candidate: { ...SIMPLE_SOURCE_DEFAULTS.candidate },
    evidence: {
      standard: { ...SIMPLE_SOURCE_DEFAULTS.standard },
      expanded: { ...SIMPLE_SOURCE_DEFAULTS.expanded },
    },
    limits: { ...SIMPLE_SOURCE_DEFAULTS.limits },
  };
}

function simpleEvidence(value: unknown, where: string): ScreeningPreset["evidence"] {
  if (value === undefined) return { ...SIMPLE_EVIDENCE_DEFAULTS };
  const input = object(value, where);
  return {
    targetItems: input.targetItems === undefined ? SIMPLE_EVIDENCE_DEFAULTS.targetItems : integer(input.targetItems, `${where}.targetItems`, 1, 10_000),
    maxItems: input.maxItems === undefined ? SIMPLE_EVIDENCE_DEFAULTS.maxItems : integer(input.maxItems, `${where}.maxItems`, 1, 10_000),
    maxSources: input.maxSources === undefined ? SIMPLE_EVIDENCE_DEFAULTS.maxSources : integer(input.maxSources, `${where}.maxSources`, 1, 10_000),
    maxChars: input.maxChars === undefined ? SIMPLE_EVIDENCE_DEFAULTS.maxChars : integer(input.maxChars, `${where}.maxChars`, 1, 10_000_000),
    maxTokens: input.maxTokens === undefined ? SIMPLE_EVIDENCE_DEFAULTS.maxTokens : integer(input.maxTokens, `${where}.maxTokens`, 1, 1_000_000),
  };
}

function parseSimplePreset(input: Record<string, unknown>, source: string): ScreeningPreset {
  if (input.provider !== undefined || input.primary !== undefined || input.refinement !== undefined) {
    throw new Error(`${source}: simple preset cannot mix source/question with provider/primary/refinement`);
  }
  const id = string(input.id, `${source}.id`);
  const question = string(input.question, `${source}.question`);
  const classifier = input.classifier === undefined ? {} : object(input.classifier, `${source}.classifier`);
  const review = input.review === undefined ? {} : object(input.review, `${source}.review`);
  const config = simpleSource(input.source, `${source}.source`);
  const dropHints = simpleDropHints(input.dropHints, `${source}.dropHints`);
  const threshold = classifier.threshold === undefined
    ? SIMPLE_PRIMARY_THRESHOLD
    : number(classifier.threshold, `${source}.classifier.threshold`, 0.5, 1);
  const keepWhen = optionalString(classifier.keepWhen, `${source}.classifier.keepWhen`) ??
    "The bounded candidate evidence provides concrete support for answering the semantic question YES.";
  const defaultDropWhen = "The bounded candidate evidence clearly supports answering the semantic question NO.";
  const hintClause = dropHints.length === 0
    ? ""
    : ` Evidence patterns that may support NO when explicitly present and semantically relevant: ${dropHints.map((hint, index) => `${index + 1}) ${hint}`).join("; ")}. Hints are not rules: a hint match alone is not sufficient for DROP, and ambiguity remains UNDECIDED.`;
  const dropWhen = optionalString(classifier.dropWhen, `${source}.classifier.dropWhen`) ?? `${defaultDropWhen}${hintClause}`;
  const defaultInstructions = `Semantic question: ${question}\nJudge only the bounded emitted evidence. Do not infer hidden facts, callers, or dataflow that are not shown. Missing or ambiguous context is INSUFFICIENT_EVIDENCE.`;
  const defaultConfirm = `CONFIRM only when the bounded evidence establishes a YES answer to this semantic question: ${question}`;
  const defaultReject = "Use a terminal non-finding disposition only when the bounded evidence establishes that the semantic question is not satisfied. Use INSUFFICIENT_EVIDENCE when neither conclusion is established.";

  return {
    id,
    label: optionalString(input.label, `${source}.label`) ?? id,
    description: optionalString(input.description, `${source}.description`) ?? question,
    adapter: "generic-source",
    provider: { kind: "generic-source", config },
    primary: {
      question,
      criteria: { true: keepWhen, false: dropWhen },
      threshold,
    },
    review: {
      instructions: optionalString(review.instructions, `${source}.review.instructions`) ?? defaultInstructions,
      confirmWhen: optionalString(review.confirmWhen, `${source}.review.confirmWhen`) ?? defaultConfirm,
      rejectWhen: optionalString(review.rejectWhen, `${source}.review.rejectWhen`) ?? defaultReject,
    },
    evidence: simpleEvidence(input.evidence, `${source}.evidence`),
  };
}

function parseAdvancedPreset(input: Record<string, unknown>, source: string): ScreeningPreset {
  const selectedProvider = provider(input.provider);
  const review = object(input.review, `${source}.review`);
  const evidence = object(input.evidence, `${source}.evidence`);
  const id = string(input.id, `${source}.id`);
  return {
    id,
    label: string(input.label, `${source}.label`),
    description: string(input.description, `${source}.description`),
    adapter: selectedProvider.adapter,
    provider: selectedProvider.spec,
    primary: stage(input.primary, `${source}.primary`),
    ...(input.refinement === undefined ? {} : { refinement: stage(input.refinement, `${source}.refinement`) }),
    review: {
      instructions: string(review.instructions, `${source}.review.instructions`),
      confirmWhen: string(review.confirmWhen, `${source}.review.confirmWhen`),
      rejectWhen: string(review.rejectWhen, `${source}.review.rejectWhen`),
    },
    evidence: {
      targetItems: integer(evidence.targetItems, `${source}.evidence.targetItems`, 1, 10_000),
      maxItems: integer(evidence.maxItems, `${source}.evidence.maxItems`, 1, 10_000),
      maxSources: integer(evidence.maxSources, `${source}.evidence.maxSources`, 1, 10_000),
      maxChars: integer(evidence.maxChars, `${source}.evidence.maxChars`, 1, 10_000_000),
      maxTokens: integer(evidence.maxTokens, `${source}.evidence.maxTokens`, 1, 1_000_000),
    },
  };
}

export function parseDeclarativePreset(value: unknown, source = "declarative preset"): ScreeningPreset {
  const input = object(value, source);
  const isSimple = input.source !== undefined || input.question !== undefined;
  return isSimple ? parseSimplePreset(input, source) : parseAdvancedPreset(input, source);
}

export function loadDeclarativePresetFile(filePath: string): ScreeningPreset {
  const absolute = path.resolve(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new Error(`failed to load declarative preset ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseDeclarativePreset(parsed, absolute);
}
