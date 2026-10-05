import { genericReviewContract, type ReviewContract, type ReviewDispositionId } from "./review-contract.ts";

export interface ReviewDecision {
  id: string;
  disposition: ReviewDispositionId;
  rationale: string;
}

export type ReviewDecisionTuple = [string, ReviewDispositionId, string];
export type ReviewDecisionInput = ReviewDecision | ReviewDecisionTuple;

export function normalizeReviewDecision(input: ReviewDecisionInput): ReviewDecision {
  if (Array.isArray(input)) {
    const [id, disposition, rationale] = input;
    return { id, disposition, rationale };
  }
  return input;
}

export function normalizeReviewDecisions(inputs: ReviewDecisionInput[]): ReviewDecision[] {
  return inputs.map(normalizeReviewDecision);
}

export interface ReviewBlockedItem { id: string; rationale: string; }
export interface ReviewFindingItem { id: string; rationale: string; }

export interface ReviewApplyResult {
  status: "ok" | "error";
  detail: "standard" | "expanded";
  packetIds: string[];
  reviewedIds: string[];
  evidenceSeenIds: string[];
  needsExpandedEvidenceIds: string[];
  blockedEvidence: ReviewBlockedItem[];
  findings: ReviewFindingItem[];
  dispositionCounts: Record<string, number>;
  issues: string[];
}

function emptyCounts(contract: ReviewContract): Record<string, number> {
  return Object.fromEntries(contract.dispositions.map((entry) => [entry.id, 0]));
}

function errorResult(detail: "standard" | "expanded", packetIds: string[], issues: string[], contract: ReviewContract): ReviewApplyResult {
  return { status: "error", detail, packetIds: [...packetIds], reviewedIds: [], evidenceSeenIds: [], needsExpandedEvidenceIds: [], blockedEvidence: [], findings: [], dispositionCounts: emptyCounts(contract), issues };
}

export function applyReviewDispositions(input: {
  packetIds: string[];
  detail: "standard" | "expanded";
  dispositions: ReviewDecision[];
  contract?: ReviewContract;
}): ReviewApplyResult {
  const packetIds = [...input.packetIds];
  const packetSet = new Set(packetIds);
  const contract = input.contract ?? genericReviewContract();
  const allowed = new Map(contract.dispositions.map((entry) => [entry.id, entry]));
  const issues: string[] = [];
  if (packetIds.length === 0) issues.push("packetIds must not be empty");
  if (packetSet.size !== packetIds.length) issues.push("packetIds contains duplicate ids");
  const byId = new Map<string, ReviewDecision>();
  for (const decision of input.dispositions) {
    if (byId.has(decision.id)) { issues.push(`duplicate disposition id: ${decision.id}`); continue; }
    if (!packetSet.has(decision.id)) issues.push(`extra disposition id: ${decision.id}`);
    if (!allowed.has(decision.disposition)) issues.push(`unknown disposition for ${decision.id}: ${decision.disposition}`);
    if (!decision.rationale.trim()) issues.push(`empty rationale for disposition id: ${decision.id}`);
    byId.set(decision.id, decision);
  }
  for (const id of packetIds) if (!byId.has(id)) issues.push(`missing disposition id: ${id}`);
  if (input.dispositions.length !== packetIds.length) issues.push(`disposition count ${input.dispositions.length} does not equal packet id count ${packetIds.length}`);
  if (issues.length > 0) return errorResult(input.detail, packetIds, issues, contract);

  const reviewedIds: string[] = [], evidenceSeenIds: string[] = [], needsExpandedEvidenceIds: string[] = [];
  const blockedEvidence: ReviewBlockedItem[] = [], findings: ReviewFindingItem[] = [];
  const dispositionCounts = emptyCounts(contract);
  for (const id of packetIds) {
    const decision = byId.get(id)!;
    dispositionCounts[decision.disposition] += 1;
    evidenceSeenIds.push(id);
    if (decision.disposition === "INSUFFICIENT_EVIDENCE") {
      if (input.detail === "standard") needsExpandedEvidenceIds.push(id);
      else blockedEvidence.push({ id, rationale: decision.rationale.trim() });
      continue;
    }
    reviewedIds.push(id);
    if (allowed.get(decision.disposition)?.finding) findings.push({ id, rationale: decision.rationale.trim() });
  }
  return { status: "ok", detail: input.detail, packetIds, reviewedIds, evidenceSeenIds, needsExpandedEvidenceIds, blockedEvidence, findings, dispositionCounts, issues: [] };
}
