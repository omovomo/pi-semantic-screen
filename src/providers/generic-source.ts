import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import {
  EVIDENCE_PROVIDER_API_VERSION,
  type EvidenceCandidate,
  type EvidenceDiscoverResult,
  type EvidenceProvider,
  type EvidenceResult,
} from "./types.ts";

export interface GenericSourcePattern {
  id: string;
  regex: string;
  flags?: string;
  label?: string;
}

export interface GenericSourceWindow {
  beforeLines?: number;
  afterLines?: number;
  maxChars?: number;
}

export interface GenericSourceProviderConfig {
  include: string[];
  exclude?: string[];
  /** Directory names to skip in addition to source-control metadata directories. */
  skipDirs?: string[];
  patterns: GenericSourcePattern[];
  candidate?: GenericSourceWindow;
  evidence?: {
    standard?: GenericSourceWindow;
    expanded?: GenericSourceWindow;
  };
  limits?: {
    maxFiles?: number;
    maxFileBytes?: number;
    maxCandidates?: number;
  };
}

interface SourceFile {
  relative: string;
  absolute: string;
  text: string;
  lines: string[];
  lineStarts: number[];
}

interface LocatedCandidate extends EvidenceCandidate {
  source: string;
  patternId: string;
  patternLabel: string;
  line: number;
  column: number;
  offset: number;
  matchText: string;
  file: SourceFile;
}

const DEFAULT_SKIP_DIRS = new Set([".git", ".hg", ".svn"]);
const DEFAULT_LIMITS = { maxFiles: 10_000, maxFileBytes: 1_000_000, maxCandidates: 100_000 };
const DEFAULT_CANDIDATE_WINDOW = { beforeLines: 1, afterLines: 4, maxChars: 3_000 };
const DEFAULT_STANDARD_WINDOW = { beforeLines: 4, afterLines: 12, maxChars: 10_000 };
const DEFAULT_EXPANDED_WINDOW = { beforeLines: 12, afterLines: 36, maxChars: 24_000 };

function normalizedSlash(value: string): string {
  return value.split(path.sep).join("/");
}

function globToRegExp(glob: string): RegExp {
  const normalized = normalizedSlash(glob).replace(/^\.\//, "");
  let out = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        i += 1;
        if (normalized[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[\\^$+?.()|{}\[\]]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

function compilePatterns(config: GenericSourceProviderConfig): Array<GenericSourcePattern & { compiled: RegExp }> {
  return config.patterns.map((pattern) => {
    const flags = pattern.flags ?? "";
    if (/[^imsu]/.test(flags)) throw new Error(`pattern ${pattern.id}: flags may contain only i, m, s, u`);
    const compiled = new RegExp(pattern.regex, flags.includes("g") ? flags : `${flags}g`);
    return { ...pattern, compiled };
  });
}

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`invalid bounded integer: ${value}; expected ${min}..${max}`);
  }
  return value;
}

function windowConfig(input: GenericSourceWindow | undefined, fallback: typeof DEFAULT_STANDARD_WINDOW) {
  return {
    beforeLines: boundedInt(input?.beforeLines, fallback.beforeLines, 0, 500),
    afterLines: boundedInt(input?.afterLines, fallback.afterLines, 0, 500),
    maxChars: boundedInt(input?.maxChars, fallback.maxChars, 1, 200_000),
  };
}

function validateConfig(config: GenericSourceProviderConfig): void {
  if (!Array.isArray(config.include) || config.include.length === 0 || config.include.some((x) => !x?.trim())) {
    throw new Error("generic-source include must contain at least one non-empty glob");
  }
  if (!Array.isArray(config.patterns) || config.patterns.length === 0) {
    throw new Error("generic-source patterns must contain at least one pattern");
  }
  const ids = config.patterns.map((pattern) => pattern.id);
  if (ids.some((id) => !id?.trim()) || new Set(ids).size !== ids.length) {
    throw new Error("generic-source pattern ids must be non-empty and unique");
  }
  if (config.skipDirs !== undefined) {
    if (!Array.isArray(config.skipDirs) || config.skipDirs.some((name) => !name?.trim())) {
      throw new Error("generic-source skipDirs must contain non-empty directory names");
    }
    for (const name of config.skipDirs) {
      if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
        throw new Error(`generic-source skipDirs entries must be directory names, not paths: ${name}`);
      }
    }
  }
  compilePatterns(config);
  windowConfig(config.candidate, DEFAULT_CANDIDATE_WINDOW);
  windowConfig(config.evidence?.standard, DEFAULT_STANDARD_WINDOW);
  windowConfig(config.evidence?.expanded, DEFAULT_EXPANDED_WINDOW);
  boundedInt(config.limits?.maxFiles, DEFAULT_LIMITS.maxFiles, 1, 100_000);
  boundedInt(config.limits?.maxFileBytes, DEFAULT_LIMITS.maxFileBytes, 1, 20_000_000);
  boundedInt(config.limits?.maxCandidates, DEFAULT_LIMITS.maxCandidates, 1, 1_000_000);
}

async function sourceFiles(scope: string, config: GenericSourceProviderConfig, signal?: AbortSignal): Promise<SourceFile[]> {
  const root = path.resolve(scope);
  const rootStat = await stat(root);
  const include = config.include.map(globToRegExp);
  const exclude = (config.exclude ?? []).map(globToRegExp);
  const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...(config.skipDirs ?? [])]);
  const maxFiles = boundedInt(config.limits?.maxFiles, DEFAULT_LIMITS.maxFiles, 1, 100_000);
  const maxFileBytes = boundedInt(config.limits?.maxFileBytes, DEFAULT_LIMITS.maxFileBytes, 1, 20_000_000);
  const files: Array<{ absolute: string; relative: string }> = [];

  function selected(relative: string): boolean {
    return include.some((pattern) => pattern.test(relative)) && !exclude.some((pattern) => pattern.test(relative));
  }

  if (rootStat.isFile()) {
    const relative = normalizedSlash(path.basename(root));
    if (selected(relative)) files.push({ absolute: root, relative });
  } else if (rootStat.isDirectory()) {
    async function walk(dir: string): Promise<void> {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!skipDirs.has(entry.name)) await walk(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        const relative = normalizedSlash(path.relative(root, absolute));
        if (!selected(relative)) continue;
        files.push({ absolute, relative });
        if (files.length > maxFiles) throw new Error(`generic-source file limit exceeded: ${maxFiles}`);
      }
    }
    await walk(root);
  } else {
    throw new Error(`scope is neither a regular file nor a directory: ${scope}`);
  }

  if (files.length > maxFiles) throw new Error(`generic-source file limit exceeded: ${maxFiles}`);
  const loaded: SourceFile[] = [];
  for (const file of files) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const fileStat = await stat(file.absolute);
    if (fileStat.size > maxFileBytes) {
      throw new Error(`generic-source file exceeds maxFileBytes (${maxFileBytes}): ${file.relative} (${fileStat.size})`);
    }
    const text = await readFile(file.absolute, "utf8");
    const lines = text.split(/\r?\n/);
    const lineStarts: number[] = [0];
    for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
    loaded.push({ relative: file.relative, absolute: file.absolute, text, lines, lineStarts });
  }
  return loaded;
}

function lineColumn(file: SourceFile, offset: number): { line: number; column: number } {
  let low = 0;
  let high = file.lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (file.lineStarts[mid] <= offset) low = mid + 1;
    else high = mid - 1;
  }
  const index = Math.max(0, high);
  return { line: index + 1, column: offset - file.lineStarts[index] + 1 };
}

function renderWindow(file: SourceFile, line: number, window: ReturnType<typeof windowConfig>): string {
  const start = Math.max(1, line - window.beforeLines);
  const end = Math.min(file.lines.length, line + window.afterLines);
  const rendered: string[] = [];
  for (let current = start; current <= end; current += 1) {
    rendered.push(`${current === line ? ">" : " "}${String(current).padStart(5, " ")} | ${file.lines[current - 1] ?? ""}`);
  }
  const text = rendered.join("\n");
  return text.length <= window.maxChars ? text : `${text.slice(0, Math.max(0, window.maxChars - 24))}\n[window truncated]`;
}

function shortHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`.slice(0, 12);
}

function candidateId(patternId: string, file: SourceFile, offset: number, matchText: string): string {
  const { line, column } = lineColumn(file, offset);
  const digest = shortHash(`${patternId}\0${matchText}`);
  return `gs:${patternId}:${file.relative}:${line}:${column}:${digest}`;
}

async function discoverLocated(
  scope: string,
  config: GenericSourceProviderConfig,
  signal?: AbortSignal,
): Promise<LocatedCandidate[]> {
  validateConfig(config);
  const patterns = compilePatterns(config);
  const files = await sourceFiles(scope, config, signal);
  const candidateWindow = windowConfig(config.candidate, DEFAULT_CANDIDATE_WINDOW);
  const maxCandidates = boundedInt(config.limits?.maxCandidates, DEFAULT_LIMITS.maxCandidates, 1, 1_000_000);
  const candidates: LocatedCandidate[] = [];

  for (const file of files) {
    for (const pattern of patterns) {
      pattern.compiled.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.compiled.exec(file.text)) !== null) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const { line, column } = lineColumn(file, match.index);
        const id = candidateId(pattern.id, file, match.index, match[0]);
        const patternLabel = pattern.label ?? pattern.id;
        const snippet = renderWindow(file, line, candidateWindow);
        candidates.push({
          id,
          text: `source=${file.relative}\npattern=${patternLabel}\nlocation=${line}:${column}\n${snippet}`,
          source: file.relative,
          patternId: pattern.id,
          patternLabel,
          line,
          column,
          offset: match.index,
          matchText: match[0],
          file,
        });
        if (candidates.length > maxCandidates) throw new Error(`generic-source candidate limit exceeded: ${maxCandidates}`);
        if (match[0].length === 0) pattern.compiled.lastIndex += 1;
      }
    }
  }
  candidates.sort((a, b) =>
    a.source.localeCompare(b.source) || a.offset - b.offset || a.patternId.localeCompare(b.patternId) || a.id.localeCompare(b.id),
  );
  return candidates;
}

function errorDiscover(id: string, scope: string, error: unknown): EvidenceDiscoverResult {
  return { status: "error", adapter: id, scope, total: 0, issues: [{ message: error instanceof Error ? error.message : String(error) }] };
}

function errorEvidence(id: string, scope: string, requested: number, error: unknown): EvidenceResult {
  return {
    status: "error",
    adapter: id,
    scope,
    requested,
    packetIds: [],
    sourceCount: 0,
    chars: 0,
    items: [],
    issues: [{ message: error instanceof Error ? error.message : String(error) }],
  };
}

export function createGenericSourceProvider(id: string, config: GenericSourceProviderConfig): EvidenceProvider {
  validateConfig(config);
  const providerId = `generic-source:${id}`;
  return {
    apiVersion: EVIDENCE_PROVIDER_API_VERSION,
    id: providerId,
    label: `Generic source provider (${id})`,
    async discover(request) {
      try {
        const located = await discoverLocated(request.scope, config, request.signal);
        return {
          status: "ok",
          adapter: providerId,
          scope: request.scope,
          total: located.length,
          ...(request.mode === "candidates"
            ? {
                items: located.map(({ id: candidateIdValue, text, source, line, column }) => ({
                  id: candidateIdValue,
                  text,
                  source,
                  line,
                  column,
                })),
              }
            : {}),
        };
      } catch (error) {
        return errorDiscover(providerId, request.scope, error);
      }
    },
    async evidence(request) {
      try {
        const located = await discoverLocated(request.scope, config, request.signal);
        const byId = new Map(located.map((candidate) => [candidate.id, candidate]));
        const missing = request.ids.filter((candidateIdValue) => !byId.has(candidateIdValue));
        if (missing.length > 0) {
          throw new Error(`stale or unknown candidate ids: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? " ..." : ""}`);
        }
        const detail = request.detail ?? "standard";
        const selectedWindow = windowConfig(
          detail === "expanded" ? config.evidence?.expanded : config.evidence?.standard,
          detail === "expanded" ? DEFAULT_EXPANDED_WINDOW : DEFAULT_STANDARD_WINDOW,
        );
        const items: EvidenceResult["items"] = [];
        const packetIds: string[] = [];
        const sources = new Set<string>();
        let chars = 0;
        for (const candidateIdValue of request.ids) {
          if (items.length >= request.maxItems) break;
          const candidate = byId.get(candidateIdValue)!;
          const isNewSource = !sources.has(candidate.source);
          if (isNewSource && sources.size >= request.maxSources) break;
          const body = [
            `provider=generic-source`,
            `detail=${detail}`,
            `pattern=${candidate.patternLabel}`,
            `location=${candidate.source}:${candidate.line}:${candidate.column}`,
            `matched=${JSON.stringify(candidate.matchText)}`,
            renderWindow(candidate.file, candidate.line, selectedWindow),
          ].join("\n");
          if (chars + body.length > request.maxChars) break;
          items.push({ id: candidate.id, source: candidate.source, evidence: body });
          packetIds.push(candidate.id);
          sources.add(candidate.source);
          chars += body.length;
        }
        return {
          status: "ok",
          adapter: providerId,
          scope: request.scope,
          requested: request.ids.length,
          packetIds,
          sourceCount: sources.size,
          chars,
          items,
        };
      } catch (error) {
        return errorEvidence(providerId, request.scope, request.ids.length, error);
      }
    },
  };
}
