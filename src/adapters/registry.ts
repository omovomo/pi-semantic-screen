import type { ScreeningAdapter } from "./types.ts";
import { pythonExceptionsAdapter } from "./python-exceptions.ts";

const adapters = new Map<string, ScreeningAdapter>([
  [pythonExceptionsAdapter.id, pythonExceptionsAdapter],
]);

export function getAdapter(id: string): ScreeningAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error(`unknown semantic-screen adapter: ${id}`);
  return adapter;
}

export function listAdapters(): Array<{ id: string; label: string }> {
  return [...adapters.values()].map(({ id, label }) => ({ id, label }));
}
