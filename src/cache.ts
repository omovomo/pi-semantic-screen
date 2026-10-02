import {
  DEFAULT_CRITERIA,
  DEFAULT_THRESHOLD,
  type ScreeningInput,
  type ScreeningResult,
} from "./engine.ts";

export interface CachedScreeningResult {
  result: ScreeningResult;
  reused: boolean;
}

export async function fingerprintScreeningInput(input: ScreeningInput): Promise<string> {
  const payload = JSON.stringify({
    items: input.items.map((item) => [item.id, item.text]),
    question: input.question,
    criteria: input.criteria ?? DEFAULT_CRITERIA,
    threshold: input.threshold ?? DEFAULT_THRESHOLD,
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
