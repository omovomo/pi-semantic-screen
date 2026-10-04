import { pythonExceptionsAdapter } from "../adapters/python-exceptions.ts";
import type { ScreeningPreset } from "../presets/types.ts";
import { createGenericSourceProvider } from "./generic-source.ts";
import { EVIDENCE_PROVIDER_API_VERSION, type EvidenceProvider } from "./types.ts";

const providers = new Map<string, EvidenceProvider>([[pythonExceptionsAdapter.id, pythonExceptionsAdapter]]);

export function registerEvidenceProvider(provider: EvidenceProvider): void {
  if (provider.apiVersion !== EVIDENCE_PROVIDER_API_VERSION) {
    throw new Error(`unsupported semantic-screen provider API version: ${String(provider.apiVersion)}`);
  }
  if (!provider.id?.trim() || !provider.label?.trim()) {
    throw new Error("semantic-screen provider id and label must be non-empty");
  }
  if (typeof provider.discover !== "function" || typeof provider.evidence !== "function") {
    throw new Error(`semantic-screen provider ${provider.id} must implement discover() and evidence()`);
  }
  if (providers.has(provider.id)) throw new Error(`semantic-screen provider already registered: ${provider.id}`);
  providers.set(provider.id, provider);
}

export function getEvidenceProvider(id: string): EvidenceProvider {
  const provider = providers.get(id);
  if (!provider) throw new Error(`unknown semantic-screen evidence provider: ${id}`);
  return provider;
}

export function resolvePresetEvidenceProvider(preset: ScreeningPreset): EvidenceProvider {
  const spec = preset.provider ?? { kind: "builtin" as const, id: preset.adapter };
  if (spec.kind === "builtin") return getEvidenceProvider(spec.id);
  if (spec.kind === "generic-source") return createGenericSourceProvider(preset.id, spec.config);
  const exhaustive: never = spec;
  throw new Error(`unsupported semantic-screen provider spec: ${String(exhaustive)}`);
}

export function listEvidenceProviders(): Array<{ id: string; label: string; apiVersion: number }> {
  return [...providers.values()].map(({ id, label, apiVersion }) => ({ id, label, apiVersion }));
}
