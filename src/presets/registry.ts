import { existsSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ScreeningPreset } from "./types.ts";
import { pythonExceptionsPreset } from "./python-exceptions.ts";
import { loadDeclarativePresetFile } from "./declarative.ts";

const builtins = new Map<string, ScreeningPreset>([[pythonExceptionsPreset.id, pythonExceptionsPreset]]);
const packagePresetDir = fileURLToPath(new URL("../../presets/", import.meta.url));

function presetSearchDirs(): string[] {
  const dirs = [path.join(process.cwd(), ".pi-semantic-screen", "presets"), packagePresetDir];
  const configured = process.env.PI_SEMANTIC_SCREEN_PRESET_DIR?.trim();
  if (configured) dirs.unshift(path.resolve(configured));
  return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

function candidatePath(id: string): string | undefined {
  if (id.endsWith(".json") || id.includes("/") || id.includes("\\")) {
    const explicit = path.resolve(id);
    return existsSync(explicit) ? explicit : undefined;
  }
  for (const dir of presetSearchDirs()) {
    const candidate = path.join(dir, `${id}.json`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function getPreset(id: string): ScreeningPreset {
  const builtin = builtins.get(id);
  if (builtin) return builtin;
  const filePath = candidatePath(id);
  if (!filePath) throw new Error(`unknown semantic-screen preset: ${id}`);
  const preset = loadDeclarativePresetFile(filePath);
  if (!id.endsWith(".json") && !id.includes("/") && !id.includes("\\") && preset.id !== id) {
    throw new Error(`declarative preset id mismatch: requested ${id}, file declares ${preset.id}`);
  }
  return preset;
}

export function listPresets(): Array<{ id: string; label: string; description: string; adapter: string }> {
  const result = new Map<string, { id: string; label: string; description: string; adapter: string }>();
  for (const preset of builtins.values()) {
    result.set(preset.id, { id: preset.id, label: preset.label, description: preset.description, adapter: preset.adapter });
  }
  for (const dir of presetSearchDirs()) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort()) {
      try {
        const preset = loadDeclarativePresetFile(path.join(dir, name));
        if (!result.has(preset.id)) {
          result.set(preset.id, { id: preset.id, label: preset.label, description: preset.description, adapter: preset.adapter });
        }
      } catch {
        // Listing is best-effort. Direct getPreset remains fail-closed and surfaces malformed config.
      }
    }
  }
  return [...result.values()];
}
