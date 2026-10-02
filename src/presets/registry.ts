import type { ScreeningPreset } from "./types.ts";
import { pythonExceptionsPreset } from "./python-exceptions.ts";

const presets = new Map<string, ScreeningPreset>([
  [pythonExceptionsPreset.id, pythonExceptionsPreset],
]);

export function getPreset(id: string): ScreeningPreset {
  const preset = presets.get(id);
  if (!preset) throw new Error(`unknown semantic-screen preset: ${id}`);
  return preset;
}

export function listPresets(): Array<{ id: string; label: string; description: string; adapter: string }> {
  return [...presets.values()].map(({ id, label, description, adapter }) => ({ id, label, description, adapter }));
}
