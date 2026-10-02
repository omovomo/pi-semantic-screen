export interface AdapterCandidate {
  id: string;
  text: string;
}

export interface AdapterIssue {
  source?: string;
  message: string;
}

export interface AdapterDiscoverRequest {
  scope: string;
  mode: "count" | "candidates";
  signal?: AbortSignal;
}

export interface AdapterDiscoverResult {
  status: "ok" | "error";
  adapter: string;
  scope: string;
  total: number;
  items?: AdapterCandidate[];
  issues?: AdapterIssue[];
}

export interface AdapterEvidenceRequest {
  scope: string;
  ids: string[];
  maxItems: number;
  maxSources: number;
  maxChars: number;
  detail?: "standard" | "expanded";
  signal?: AbortSignal;
}

export interface AdapterEvidenceItem {
  id: string;
  source: string;
  evidence: string;
}

export interface AdapterEvidenceResult {
  status: "ok" | "error";
  adapter: string;
  scope: string;
  requested: number;
  packetIds: string[];
  sourceCount: number;
  chars: number;
  items: AdapterEvidenceItem[];
  issues?: AdapterIssue[];
}

export interface ScreeningAdapter {
  id: string;
  label: string;
  discover(request: AdapterDiscoverRequest): Promise<AdapterDiscoverResult>;
  evidence(request: AdapterEvidenceRequest): Promise<AdapterEvidenceResult>;
}
