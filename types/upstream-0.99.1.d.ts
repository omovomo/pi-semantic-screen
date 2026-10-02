declare module "@earendil-works/pi-ai" {
  export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
  export interface ClassifierContext {
    state: Record<string, unknown>;
    questions: Record<string, unknown>;
  }
  export type ClassifierApi = string;
  export interface ClassifierModel<TApi extends ClassifierApi = ClassifierApi> {
    type: "classifier";
    provider: string;
    id: string;
    contextWindow: number;
  }
  export interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h?: number;
    reasoning?: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  }
  export interface ClassifierResult {
    stopReason: "stop" | "error" | "aborted";
    errorMessage?: string;
    answers: Record<string, unknown>;
    usage?: Usage;
  }
}

declare module "@earendil-works/pi-coding-agent" {
  import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
  export interface ExtensionContext {
    getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
    compact(options?: {
      customInstructions?: string;
      onComplete?: (result: unknown) => void;
      onError?: (error: Error) => void;
    }): void;
  }
  export interface ExtensionAPI {
    on(event: "before_agent_start", handler: (event: { prompt: string }, ctx: ExtensionContext) => void | Promise<void>): () => void;
    on(event: "turn_end", handler: (event: { message: unknown }, ctx: ExtensionContext) => void | Promise<void>): () => void;
    on(event: "session_start", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): () => void;
    on(event: "session_compact", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): () => void;
    on(event: "session_compact_failed", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): () => void;
    registerTool(definition: {
      name: string;
      label: string;
      description: string;
      promptSnippet?: string;
      parameters: unknown;
      outputSchema?: unknown;
      annotations?: Record<string, unknown>;
      executionMode?: "sequential" | "parallel";
      execute: (
        toolCallId: string,
        params: any,
        signal?: AbortSignal,
        onUpdate?: unknown,
        ctx?: unknown,
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: unknown;
        structuredContent?: unknown;
        usage?: import("@earendil-works/pi-ai").Usage;
      }>;
    }): void;
  }
  export class ModelRuntime {
    static create(options?: {
      allowModelNetwork?: boolean;
      refreshOnCreate?: boolean;
    }): Promise<ModelRuntime>;
    refresh(options?: { allowNetwork?: boolean; signal?: AbortSignal }): Promise<{
      aborted: boolean;
      errors: Map<string, Error>;
    }>;
    getAvailableOfType(
      type: "classifier",
      providerId?: string,
      options?: { signal?: AbortSignal },
    ): Promise<readonly ClassifierModel<ClassifierApi>[]>;
    getModelOfType(type: "classifier", providerId: string, modelId: string): ClassifierModel<ClassifierApi> | undefined;
    classify(
      model: ClassifierModel<ClassifierApi>,
      context: ClassifierContext,
      options?: { signal?: AbortSignal },
    ): Promise<ClassifierResult>;
  }
  export function estimateTokens(message: { role: "user"; content: string; timestamp: number }): number;
}
