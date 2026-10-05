import assert from "node:assert/strict";
import test from "node:test";
import { ReviewWorkflowManager, type ReviewEvidencePacket } from "../src/review-workflow.ts";

function packet(ids: string[], detail: "standard" | "expanded"): ReviewEvidencePacket {
  return {
    status: "ok",
    detail,
    packetIds: ids,
    items: ids.map((id) => ({ id, source: `${id}.py`, evidence: `evidence:${id}:${detail}` })),
  };
}

test("review workflow next is idempotent until the pending packet is committed", async () => {
  const manager = new ReviewWorkflowManager();
  const start = manager.start({ preset: "p", scope: ".", reviewTargetIds: ["a", "b"], targetItems: 2 });
  assert.equal(start.status, "ok");
  let builds = 0;
  const build = async ({ ids, detail }: { ids: string[]; detail: "standard" | "expanded" }) => {
    builds += 1;
    return packet(ids, detail);
  };
  const first = await manager.next(start.workflowId, build);
  const repeated = await manager.next(start.workflowId, build);
  assert.equal(first.status, "packet");
  assert.equal(repeated.status, "packet");
  assert.equal(repeated.packetId, first.packetId);
  assert.equal(builds, 1);
});

test("review workflow commit atomically queues expanded evidence and prioritizes it", async () => {
  const manager = new ReviewWorkflowManager();
  const start = manager.start({ preset: "p", scope: ".", reviewTargetIds: ["a", "b", "c"], targetItems: 3 });
  const build = async ({ ids, detail }: { ids: string[]; detail: "standard" | "expanded" }) => packet(ids, detail);
  const first = await manager.next(start.workflowId, build);
  assert.equal(first.status, "packet");
  const committed = manager.commit({
    workflowId: start.workflowId,
    packetId: first.packetId!,
    dispositions: [
      { id: "a", disposition: "CONFIRM", rationale: "hidden default" },
      { id: "b", disposition: "INSUFFICIENT_EVIDENCE", rationale: "needs downstream" },
      { id: "c", disposition: "REJECT", rationale: "display only" },
    ],
  });
  assert.equal(committed.status, "ready");
  assert.equal(committed.progress?.semanticallyReviewed, 2);
  assert.equal(committed.progress?.needsExpandedEvidence, 1);
  assert.equal(committed.progress?.standardReviewed, 3);
  assert.equal(committed.progress?.standardResolved, 2);
  const next = await manager.next(start.workflowId, build);
  assert.equal(next.status, "packet");
  assert.equal(next.packet?.detail, "expanded");
  assert.deepEqual(next.packet?.packetIds, ["b"]);
});

test("expanded insufficient evidence is quarantined while independent targets continue", async () => {
  const manager = new ReviewWorkflowManager();
  const start = manager.start({ preset: "p", scope: ".", reviewTargetIds: ["a", "b"], targetItems: 1 });
  const build = async ({ ids, detail }: { ids: string[]; detail: "standard" | "expanded" }) => packet(ids, detail);
  const p1 = await manager.next(start.workflowId, build);
  manager.commit({
    workflowId: start.workflowId,
    packetId: p1.packetId!,
    dispositions: [{ id: "a", disposition: "INSUFFICIENT_EVIDENCE", rationale: "needs more" }],
  });
  const p2 = await manager.next(start.workflowId, build);
  assert.equal(p2.packet?.detail, "expanded");
  const c2 = manager.commit({
    workflowId: start.workflowId,
    packetId: p2.packetId!,
    dispositions: [{ id: "a", disposition: "INSUFFICIENT_EVIDENCE", rationale: "still ambiguous" }],
  });
  assert.equal(c2.status, "ready");
  assert.equal(c2.progress?.blockedEvidence, 1);
  const p3 = await manager.next(start.workflowId, build);
  assert.equal(p3.status, "packet");
  assert.deepEqual(p3.packet?.packetIds, ["b"]);
});

test("stale packet commits fail closed and preserve pending state", async () => {
  const manager = new ReviewWorkflowManager();
  const start = manager.start({ preset: "p", scope: ".", reviewTargetIds: ["a"], targetItems: 1 });
  const build = async ({ ids, detail }: { ids: string[]; detail: "standard" | "expanded" }) => packet(ids, detail);
  const current = await manager.next(start.workflowId, build);
  const stale = manager.commit({
    workflowId: start.workflowId,
    packetId: "wrong",
    dispositions: [{ id: "a", disposition: "REJECT", rationale: "ui" }],
  });
  assert.equal(stale.status, "error");
  const repeated = await manager.next(start.workflowId, build);
  assert.equal(repeated.packetId, current.packetId);
});

test("terminal workflow returns full findings, blocked evidence, and cumulative counts", async () => {
  const manager = new ReviewWorkflowManager();
  const start = manager.start({ preset: "p", scope: ".", reviewTargetIds: ["a", "b"], targetItems: 2 });
  const build = async ({ ids, detail }: { ids: string[]; detail: "standard" | "expanded" }) => packet(ids, detail);
  const first = await manager.next(start.workflowId, build);
  manager.commit({
    workflowId: start.workflowId,
    packetId: first.packetId!,
    dispositions: [
      { id: "a", disposition: "CONFIRM", rationale: "core failure hidden" },
      { id: "b", disposition: "INSUFFICIENT_EVIDENCE", rationale: "needs more" },
    ],
  });
  const expanded = await manager.next(start.workflowId, build);
  const final = manager.commit({
    workflowId: start.workflowId,
    packetId: expanded.packetId!,
    dispositions: [{ id: "b", disposition: "INSUFFICIENT_EVIDENCE", rationale: "still ambiguous" }],
  });
  assert.equal(final.status, "review_complete_with_blocked_evidence");
  assert.equal(final.progress?.semanticallyReviewed, 1);
  assert.equal(final.progress?.blockedEvidence, 1);
  assert.equal(final.progress?.expandedAttempted, 1);
  assert.equal(final.progress?.expandedResolved, 0);
  assert.equal(final.progress?.expandedBlocked, 1);
  assert.equal(final.progress?.expansionRate, 0.5);
  assert.equal(final.progress?.expandedResolutionRate, 0);
  assert.equal(final.progress?.resumeAvailable, false);
  assert.deepEqual(final.findings, [{ id: "a", rationale: "core failure hidden" }]);
  assert.deepEqual(final.blockedEvidence, [{ id: "b", rationale: "still ambiguous" }]);
  assert.equal(final.dispositionCounts?.CONFIRM, 1);
  assert.equal(final.dispositionCounts?.INSUFFICIENT_EVIDENCE, 2);
  assert.equal(final.dispositionEventCounts?.CONFIRM, 1);
  assert.equal(final.dispositionEventCounts?.INSUFFICIENT_EVIDENCE, 2);
  assert.equal(final.finalDispositionCounts?.CONFIRM, 1);
  assert.equal(final.finalDispositionCounts?.INSUFFICIENT_EVIDENCE, 1);
  assert.equal(
    Object.values(final.finalDispositionCounts ?? {}).reduce((sum, count) => sum + count, 0),
    2,
  );
});

test("latest workflow can be resumed without model-owned review state", async () => {
  const manager = new ReviewWorkflowManager();
  manager.start({ preset: "p", scope: ".", reviewTargetIds: ["a"], targetItems: 1 });
  const result = await manager.next(undefined, async ({ ids, detail }) => packet(ids, detail));
  assert.equal(result.status, "packet");
  assert.equal(result.workflowId, "review-1");
});


test("terminal next does not build or fetch empty evidence", async () => {
  const manager = new ReviewWorkflowManager();
  const start = manager.start({ preset: "p", scope: ".", reviewTargetIds: ["a"], targetItems: 1 });
  let builds = 0;
  const build = async ({ ids, detail }: { ids: string[]; detail: "standard" | "expanded" }) => {
    builds += 1;
    return packet(ids, detail);
  };
  const first = await manager.next(start.workflowId, build);
  const committed = manager.commit({
    workflowId: start.workflowId,
    packetId: first.packetId!,
    dispositions: [{ id: "a", disposition: "REJECT", rationale: "display only" }],
  });
  assert.equal(committed.status, "complete");
  const terminal = await manager.next(start.workflowId, build);
  assert.equal(terminal.status, "complete");
  assert.equal(builds, 1);
});

test("review workflow commit accepts compact tuple dispositions and normalizes them atomically", async () => {
  const manager = new ReviewWorkflowManager();
  const start = manager.start({ preset: "p", scope: ".", reviewTargetIds: ["a", "b"], targetItems: 2 });
  const build = async ({ ids, detail }: { ids: string[]; detail: "standard" | "expanded" }) => packet(ids, detail);
  const first = await manager.next(start.workflowId, build);
  assert.equal(first.status, "packet");
  const committed = manager.commit({
    workflowId: start.workflowId,
    packetId: first.packetId!,
    dispositions: [
      ["a", "CONFIRM", "hidden core fallback"],
      ["b", "REJECT", "display only"],
    ],
  });
  assert.equal(committed.status, "complete");
  assert.equal(committed.progress?.semanticallyReviewed, 2);
  assert.deepEqual(committed.findings, [{ id: "a", rationale: "hidden core fallback" }]);
  assert.equal(committed.dispositionCounts?.CONFIRM, 1);
  assert.equal(committed.dispositionCounts?.REJECT, 1);
  assert.equal(committed.dispositionEventCounts?.CONFIRM, 1);
  assert.equal(committed.dispositionEventCounts?.REJECT, 1);
  assert.equal(committed.finalDispositionCounts?.CONFIRM, 1);
  assert.equal(committed.finalDispositionCounts?.REJECT, 1);
});


test("final disposition counts record the resolved expanded outcome once per candidate", async () => {
  const manager = new ReviewWorkflowManager();
  const start = manager.start({ preset: "p", scope: ".", reviewTargetIds: ["a"], targetItems: 1 });
  const build = async ({ ids, detail }: { ids: string[]; detail: "standard" | "expanded" }) => packet(ids, detail);
  const standard = await manager.next(start.workflowId, build);
  manager.commit({
    workflowId: start.workflowId,
    packetId: standard.packetId!,
    dispositions: [{ id: "a", disposition: "INSUFFICIENT_EVIDENCE", rationale: "needs more" }],
  });
  const expanded = await manager.next(start.workflowId, build);
  const final = manager.commit({
    workflowId: start.workflowId,
    packetId: expanded.packetId!,
    dispositions: [{ id: "a", disposition: "REJECT", rationale: "expanded evidence shows explicit failure" }],
  });
  assert.equal(final.status, "complete");
  assert.equal(final.dispositionEventCounts?.INSUFFICIENT_EVIDENCE, 1);
  assert.equal(final.dispositionEventCounts?.REJECT, 1);
  assert.equal(final.finalDispositionCounts?.INSUFFICIENT_EVIDENCE, 0);
  assert.equal(final.finalDispositionCounts?.REJECT, 1);
  assert.equal(final.dispositionCounts?.INSUFFICIENT_EVIDENCE, 1);
});
