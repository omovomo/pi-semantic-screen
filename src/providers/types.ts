export interface EvidenceCandidate {
  id: string;
  text: string;
}

export interface EvidenceProviderIssue {
  source?: string;
  message: string;
}

export interface EvidenceDiscoverRequest {
  scope: string;
  mode: "count" | "candidates";
  signal?: AbortSignal;
}

export interface EvidenceDiscoverResult {
  status: "ok" | "error";
  adapter: string;
  scope: string;
  total: number;
  items?: EvidenceCandidate[];
  issues?: EvidenceProviderIssue[];
}

export interface EvidenceRequest {
  scope: string;
  ids: string[];
  maxItems: number;
  maxSources: number;
  maxChars: number;
  detail?: "standard" | "expanded";
  signal?: AbortSignal;
}

export interface EvidenceItem {
  id: string;
  source: string;
  evidence: string;
}

export interface EvidenceResult {
  status: "ok" | "error";
  adapter: string;
  scope: string;
  requested: number;
  packetIds: string[];
  sourceCount: number;
  chars: number;
  items: EvidenceItem[];
  issues?: EvidenceProviderIssue[];
}

export const EVIDENCE_PROVIDER_API_VERSION = 1 as const;

/**
 * Stable core boundary between semantic screening and deterministic source facts.
 * Providers discover candidates and return bounded evidence; they do not decide
 * whether those facts are good/bad for a preset's semantic question.
 */
export interface EvidenceProvider {
  apiVersion: typeof EVIDENCE_PROVIDER_API_VERSION;
  id: string;
  label: string;
  discover(request: EvidenceDiscoverRequest): Promise<EvidenceDiscoverResult>;
  evidence(request: EvidenceRequest): Promise<EvidenceResult>;
}
