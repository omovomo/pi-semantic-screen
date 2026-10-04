import {
  REVIEW_DISPOSITION_IDS,
  type ReviewDispositionId,
} from "./review-contract.ts";
import {
  applyReviewDispositions,
  normalizeReviewDecisions,
  type ReviewBlockedItem,
  type ReviewDecisionInput,
  type ReviewFindingItem,
} from "./review-apply.ts";

export interface ReviewEvidenceItem {
  id: string;
  source: string;
  evidence: string;
}

export interface ReviewEvidencePacket {
  status: "ok" | "error";
  detail: "standard" | "expanded";
  packetIds: string[];
  items: ReviewEvidenceItem[];
  [key: string]: unknown;
}

export interface ReviewWorkflowProgress {
  reviewTarget: number;
  semanticallyReviewed: number;
  evidenceSeen: number;
  blockedEvidence: number;
  needsExpandedEvidence: number;
  reviewableRemaining: number;
  confirmed: number;
  unreviewed: number;
  standardReviewed: number;
  standardResolved: number;
  expandedAttempted: number;
  expandedResolved: number;
  expandedBlocked: number;
  expansionRate: number;
  expandedResolutionRate: number;
  resumeAvailable: boolean;
}

export interface ReviewWorkflowStartResult {
  status: "ok" | "error";
  workflowId?: string;
  preset: string;
  scope: string;
  progress?: ReviewWorkflowProgress;
  issues: string[];
}

export interface ReviewWorkflowNextResult {
  status: "packet" | "complete" | "review_complete_with_blocked_evidence" | "error";
  workflowId?: string;
  packetId?: string;
  preset?: string;
  scope?: string;
  progress?: ReviewWorkflowProgress;
  packet?: ReviewEvidencePacket;
  findings?: ReviewFindingItem[];
  blockedEvidence?: ReviewBlockedItem[];
  dispositionCounts?: Record<ReviewDispositionId, number>;
  issues: string[];
}

export interface ReviewWorkflowCommitResult {
  status: "ready" | "complete" | "review_complete_with_blocked_evidence" | "error";
  workflowId?: string;
  packetId?: string;
  progress?: ReviewWorkflowProgress;
  newFindings: ReviewFindingItem[];
  newBlockedEvidence: ReviewBlockedItem[];
  findings?: ReviewFindingItem[];
  blockedEvidence?: ReviewBlockedItem[];
  dispositionCounts?: Record<ReviewDispositionId, number>;
  issues: string[];
}

export type ReviewPacketBuilder = (request: {
  workflowId: string;
  preset: string;
  scope: string;
  ids: string[];
  detail: "standard" | "expanded";
}) => Promise<ReviewEvidencePacket>;

interface PendingPacket {
  packetId: string;
  detail: "standard" | "expanded";
  requestedIds: string[];
  packet: ReviewEvidencePacket;
}

interface ReviewWorkflowState {
  id: string;
  preset: string;
  scope: string;
  targetItems: number;
  reviewTargetIds: string[];
  reviewedIds: Set<string>;
  evidenceSeenIds: Set<string>;
  needsExpandedEvidenceIds: Set<string>;
  blockedEvidence: Map<string, string>;
  findings: Map<string, string>;
  dispositionCounts: Record<ReviewDispositionId, number>;
  standardReviewed: number;
  standardResolved: number;
  expandedAttempted: number;
  expandedResolved: number;
  expandedBlocked: number;
  pending?: PendingPacket;
  nextPacketSequence: number;
}

function emptyDispositionCounts(): Record<ReviewDispositionId, number> {
  return Object.fromEntries(REVIEW_DISPOSITION_IDS.map((id) => [id, 0])) as Record<ReviewDispositionId, number>;
}

function exactItemCoverage(packet: ReviewEvidencePacket): string[] {
  const issues: string[] = [];
  const ids = packet.packetIds;
  const itemIds = packet.items.map((item) => item.id);
  if (ids.length === 0) issues.push("evidence packet must not be empty");
  if (new Set(ids).size !== ids.length) issues.push("evidence packet contains duplicate packet ids");
  if (new Set(itemIds).size !== itemIds.length) issues.push("evidence packet contains duplicate item ids");
  if (ids.length !== itemIds.length || ids.some((id, index) => itemIds[index] !== id)) {
    issues.push("evidence packet item ids do not exactly match packetIds in order");
  }
  return issues;
}

export class ReviewWorkflowManager {
  private workflows = new Map<string, ReviewWorkflowState>();
  private latestWorkflowId: string | undefined;
  private nextWorkflowSequence = 1;

  reset(): void {
    this.workflows.clear();
    this.latestWorkflowId = undefined;
    this.nextWorkflowSequence = 1;
  }

  start(input: {
    preset: string;
    scope: string;
    reviewTargetIds: string[];
    targetItems: number;
  }): ReviewWorkflowStartResult {
    const issues: string[] = [];
    const targetIds = [...input.reviewTargetIds];
    if (!input.preset.trim()) issues.push("preset must not be empty");
    if (!input.scope.trim()) issues.push("scope must not be empty");
    if (!Number.isInteger(input.targetItems) || input.targetItems < 1) issues.push("targetItems must be a positive integer");
    if (new Set(targetIds).size !== targetIds.length) issues.push("reviewTargetIds contains duplicate ids");
    if (targetIds.some((id) => !id.trim())) issues.push("reviewTargetIds contains an empty id");
    if (issues.length > 0) {
      return { status: "error", preset: input.preset, scope: input.scope, issues };
    }

    const workflowId = `review-${this.nextWorkflowSequence++}`;
    const state: ReviewWorkflowState = {
      id: workflowId,
      preset: input.preset,
      scope: input.scope,
      targetItems: input.targetItems,
      reviewTargetIds: targetIds,
      reviewedIds: new Set(),
      evidenceSeenIds: new Set(),
      needsExpandedEvidenceIds: new Set(),
      blockedEvidence: new Map(),
      findings: new Map(),
      dispositionCounts: emptyDispositionCounts(),
      standardReviewed: 0,
      standardResolved: 0,
      expandedAttempted: 0,
      expandedResolved: 0,
      expandedBlocked: 0,
      nextPacketSequence: 1,
    };
    this.workflows.set(workflowId, state);
    this.latestWorkflowId = workflowId;
    return {
      status: "ok",
      workflowId,
      preset: state.preset,
      scope: state.scope,
      progress: this.progress(state),
      issues: [],
    };
  }

  async next(workflowId: string | undefined, buildPacket: ReviewPacketBuilder): Promise<ReviewWorkflowNextResult> {
    const state = this.resolve(workflowId);
    if (!state) {
      return { status: "error", issues: [workflowId ? `unknown workflow: ${workflowId}` : "no active review workflow"] };
    }
    this.latestWorkflowId = state.id;

    if (state.pending) return this.packetResult(state, state.pending);

    const expandedIds = state.reviewTargetIds.filter(
      (id) => state.needsExpandedEvidenceIds.has(id) && !state.reviewedIds.has(id) && !state.blockedEvidence.has(id),
    );
    const standardIds = state.reviewTargetIds.filter(
      (id) =>
        !state.reviewedIds.has(id) &&
        !state.blockedEvidence.has(id) &&
        !state.needsExpandedEvidenceIds.has(id),
    );
    const detail: "standard" | "expanded" = expandedIds.length > 0 ? "expanded" : "standard";
    const candidates = detail === "expanded" ? expandedIds : standardIds;

    if (candidates.length === 0) return this.terminalResult(state);

    const requestedIds = candidates.slice(0, state.targetItems);
    const packet = await buildPacket({
      workflowId: state.id,
      preset: state.preset,
      scope: state.scope,
      ids: requestedIds,
      detail,
    });
    if (packet.status !== "ok") {
      return {
        status: "error",
        workflowId: state.id,
        preset: state.preset,
        scope: state.scope,
        progress: this.progress(state),
        issues: ["evidence adapter returned error"],
      };
    }

    const packetIssues = exactItemCoverage(packet);
    const requestedSet = new Set(requestedIds);
    for (const id of packet.packetIds) {
      if (!requestedSet.has(id)) packetIssues.push(`evidence packet returned unrequested id: ${id}`);
    }
    if (packetIssues.length > 0) {
      return {
        status: "error",
        workflowId: state.id,
        preset: state.preset,
        scope: state.scope,
        progress: this.progress(state),
        issues: packetIssues,
      };
    }

    const pending: PendingPacket = {
      packetId: `${state.id}:p${state.nextPacketSequence++}`,
      detail,
      requestedIds,
      packet,
    };
    state.pending = pending;
    return this.packetResult(state, pending);
  }

  commit(input: {
    workflowId?: string;
    packetId: string;
    dispositions: ReviewDecisionInput[];
  }): ReviewWorkflowCommitResult {
    const state = this.resolve(input.workflowId);
    if (!state) {
      return {
        status: "error",
        newFindings: [],
        newBlockedEvidence: [],
        issues: [input.workflowId ? `unknown workflow: ${input.workflowId}` : "no active review workflow"],
      };
    }
    this.latestWorkflowId = state.id;
    const pending = state.pending;
    if (!pending) {
      return {
        status: "error",
        workflowId: state.id,
        packetId: input.packetId,
        progress: this.progress(state),
        newFindings: [],
        newBlockedEvidence: [],
        issues: ["workflow has no pending evidence packet"],
      };
    }
    if (pending.packetId !== input.packetId) {
      return {
        status: "error",
        workflowId: state.id,
        packetId: input.packetId,
        progress: this.progress(state),
        newFindings: [],
        newBlockedEvidence: [],
        issues: [`stale packet id: expected ${pending.packetId}, got ${input.packetId}`],
      };
    }

    const applied = applyReviewDispositions({
      packetIds: pending.packet.packetIds,
      detail: pending.detail,
      dispositions: normalizeReviewDecisions(input.dispositions),
    });
    if (applied.status !== "ok") {
      return {
        status: "error",
        workflowId: state.id,
        packetId: pending.packetId,
        progress: this.progress(state),
        newFindings: [],
        newBlockedEvidence: [],
        issues: applied.issues,
      };
    }

    for (const id of pending.packet.packetIds) state.needsExpandedEvidenceIds.delete(id);
    for (const id of applied.evidenceSeenIds) state.evidenceSeenIds.add(id);
    for (const id of applied.reviewedIds) state.reviewedIds.add(id);
    for (const id of applied.needsExpandedEvidenceIds) state.needsExpandedEvidenceIds.add(id);
    for (const blocked of applied.blockedEvidence) state.blockedEvidence.set(blocked.id, blocked.rationale);
    for (const finding of applied.findings) state.findings.set(finding.id, finding.rationale);
    for (const disposition of REVIEW_DISPOSITION_IDS) {
      state.dispositionCounts[disposition] += applied.dispositionCounts[disposition];
    }
    if (pending.detail === "standard") {
      state.standardReviewed += pending.packet.packetIds.length;
      state.standardResolved += applied.reviewedIds.length;
    } else {
      state.expandedAttempted += pending.packet.packetIds.length;
      state.expandedResolved += applied.reviewedIds.length;
      state.expandedBlocked += applied.blockedEvidence.length;
    }
    state.pending = undefined;

    const terminal = this.isTerminal(state);
    const status = terminal
      ? state.blockedEvidence.size > 0
        ? "review_complete_with_blocked_evidence"
        : "complete"
      : "ready";
    return {
      status,
      workflowId: state.id,
      packetId: pending.packetId,
      progress: this.progress(state),
      newFindings: applied.findings,
      newBlockedEvidence: applied.blockedEvidence,
      findings: terminal ? this.findings(state) : undefined,
      blockedEvidence: terminal ? this.blocked(state) : undefined,
      dispositionCounts: terminal ? { ...state.dispositionCounts } : undefined,
      issues: [],
    };
  }

  private resolve(workflowId: string | undefined): ReviewWorkflowState | undefined {
    const id = workflowId ?? this.latestWorkflowId;
    return id ? this.workflows.get(id) : undefined;
  }

  private isTerminal(state: ReviewWorkflowState): boolean {
    if (state.pending) return false;
    return state.reviewTargetIds.every((id) => state.reviewedIds.has(id) || state.blockedEvidence.has(id));
  }

  private progress(state: ReviewWorkflowState): ReviewWorkflowProgress {
    const reviewableRemaining = state.reviewTargetIds.filter(
      (id) => !state.reviewedIds.has(id) && !state.blockedEvidence.has(id),
    ).length;
    const actionable = reviewableRemaining > 0 || Boolean(state.pending);
    return {
      reviewTarget: state.reviewTargetIds.length,
      semanticallyReviewed: state.reviewedIds.size,
      evidenceSeen: state.evidenceSeenIds.size,
      blockedEvidence: state.blockedEvidence.size,
      needsExpandedEvidence: state.needsExpandedEvidenceIds.size,
      reviewableRemaining,
      confirmed: state.findings.size,
      unreviewed: state.reviewTargetIds.length - state.reviewedIds.size,
      standardReviewed: state.standardReviewed,
      standardResolved: state.standardResolved,
      expandedAttempted: state.expandedAttempted,
      expandedResolved: state.expandedResolved,
      expandedBlocked: state.expandedBlocked,
      expansionRate: state.reviewTargetIds.length > 0 ? state.expandedAttempted / state.reviewTargetIds.length : 0,
      expandedResolutionRate: state.expandedAttempted > 0 ? state.expandedResolved / state.expandedAttempted : 0,
      resumeAvailable: actionable,
    };
  }

  private findings(state: ReviewWorkflowState): ReviewFindingItem[] {
    return state.reviewTargetIds
      .filter((id) => state.findings.has(id))
      .map((id) => ({ id, rationale: state.findings.get(id)! }));
  }

  private blocked(state: ReviewWorkflowState): ReviewBlockedItem[] {
    return state.reviewTargetIds
      .filter((id) => state.blockedEvidence.has(id))
      .map((id) => ({ id, rationale: state.blockedEvidence.get(id)! }));
  }

  private terminalResult(state: ReviewWorkflowState): ReviewWorkflowNextResult {
    const status = state.blockedEvidence.size > 0 ? "review_complete_with_blocked_evidence" : "complete";
    return {
      status,
      workflowId: state.id,
      preset: state.preset,
      scope: state.scope,
      progress: this.progress(state),
      findings: this.findings(state),
      blockedEvidence: this.blocked(state),
      dispositionCounts: { ...state.dispositionCounts },
      issues: [],
    };
  }

  private packetResult(state: ReviewWorkflowState, pending: PendingPacket): ReviewWorkflowNextResult {
    return {
      status: "packet",
      workflowId: state.id,
      packetId: pending.packetId,
      preset: state.preset,
      scope: state.scope,
      progress: this.progress(state),
      packet: pending.packet,
      issues: [],
    };
  }
}
