import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { GenericSourceProviderConfig } from "../providers/generic-source.ts";
import type { EvidenceProviderSpec } from "../providers/spec.ts";
import type { ScreeningPreset, ScreeningStagePreset } from "./types.ts";

function object(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where} must be a non-empty string`);
  return value;
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

export function parseDeclarativePreset(value: unknown, source = "declarative preset"): ScreeningPreset {
  const input = object(value, source);
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

export function loadDeclarativePresetFile(filePath: string): ScreeningPreset {
  const absolute = path.resolve(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new Error(`failed to load declarative preset ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const preset = parseDeclarativePreset(parsed, absolute);
  return preset;
}
