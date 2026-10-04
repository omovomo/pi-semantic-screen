import { EVIDENCE_PROVIDER_API_VERSION } from "../providers/types.ts";
import type {
  AdapterDiscoverResult,
  AdapterEvidenceResult,
  ScreeningAdapter,
} from "./types.ts";
import { runPythonJson } from "./python-runner.ts";

interface PythonAdapterRequest {
  action: "count" | "discover" | "evidence";
  scope: string;
  ids?: string[];
  maxItems?: number;
  maxSources?: number;
  maxChars?: number;
  detail?: "standard" | "expanded";
}

const scriptUrl = new URL("./python-exceptions.py", import.meta.url);

export const pythonExceptionsAdapter: ScreeningAdapter = {
  apiVersion: EVIDENCE_PROVIDER_API_VERSION,
  id: "python-exceptions",
  label: "Python exception handlers",

  async discover(request) {
    const result = await runPythonJson<PythonAdapterRequest, AdapterDiscoverResult>(
      scriptUrl,
      {
        action: request.mode === "count" ? "count" : "discover",
        scope: request.scope,
      },
      request.signal,
    );
    return { ...result, adapter: "python-exceptions" };
  },

  async evidence(request) {
    const result = await runPythonJson<PythonAdapterRequest, AdapterEvidenceResult>(
      scriptUrl,
      {
        action: "evidence",
        scope: request.scope,
        ids: request.ids,
        maxItems: request.maxItems,
        maxSources: request.maxSources,
        maxChars: request.maxChars,
        detail: request.detail,
      },
      request.signal,
    );
    return { ...result, adapter: "python-exceptions" };
  },
};
