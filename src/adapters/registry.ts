import { getEvidenceProvider, listEvidenceProviders } from "../providers/registry.ts";
import type { ScreeningAdapter } from "./types.ts";

/** @deprecated Use getEvidenceProvider / resolvePresetEvidenceProvider. */
export function getAdapter(id: string): ScreeningAdapter {
  return getEvidenceProvider(id);
}

/** @deprecated Use listEvidenceProviders. */
export function listAdapters(): Array<{ id: string; label: string }> {
  return listEvidenceProviders().map(({ id, label }) => ({ id, label }));
}
