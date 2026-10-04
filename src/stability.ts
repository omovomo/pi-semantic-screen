export interface SemanticManifestEntry {
  id: string;
  disposition: string;
}

export interface SemanticStabilitySummary {
  previous: number;
  current: number;
  commonCandidateIds: number;
  stableDisposition: number;
  changedDisposition: number;
  stability: number;
  stableConfirm: number;
  newConfirm: number;
  lostConfirm: number;
  stableBlocked: number;
  newBlocked: number;
  resolvedBlocked: number;
}

export interface SemanticStabilityOptions {
  confirmDisposition?: string;
  blockedDisposition?: string;
}

export function compareSemanticManifests(
  previous: SemanticManifestEntry[],
  current: SemanticManifestEntry[],
  options: SemanticStabilityOptions = {},
): SemanticStabilitySummary {
  const confirm = options.confirmDisposition ?? "CONFIRM";
  const blocked = options.blockedDisposition ?? "BLOCKED_EVIDENCE";
  const previousMap = new Map(previous.map((entry) => [entry.id, entry.disposition]));
  const currentMap = new Map(current.map((entry) => [entry.id, entry.disposition]));
  if (previousMap.size !== previous.length) throw new Error("previous manifest contains duplicate ids");
  if (currentMap.size !== current.length) throw new Error("current manifest contains duplicate ids");

  let commonCandidateIds = 0;
  let stableDisposition = 0;
  let changedDisposition = 0;
  let stableConfirm = 0;
  let newConfirm = 0;
  let lostConfirm = 0;
  let stableBlocked = 0;
  let newBlocked = 0;
  let resolvedBlocked = 0;

  const allIds = new Set([...previousMap.keys(), ...currentMap.keys()]);
  for (const id of allIds) {
    const before = previousMap.get(id);
    const after = currentMap.get(id);
    if (before !== undefined && after !== undefined) {
      commonCandidateIds += 1;
      if (before === after) stableDisposition += 1;
      else changedDisposition += 1;
    }
    if (before === confirm && after === confirm) stableConfirm += 1;
    else if (after === confirm && before !== confirm) newConfirm += 1;
    else if (before === confirm && after !== confirm) lostConfirm += 1;

    if (before === blocked && after === blocked) stableBlocked += 1;
    else if (after === blocked && before !== blocked) newBlocked += 1;
    else if (before === blocked && after !== blocked) resolvedBlocked += 1;
  }

  return {
    previous: previous.length,
    current: current.length,
    commonCandidateIds,
    stableDisposition,
    changedDisposition,
    stability: commonCandidateIds > 0 ? stableDisposition / commonCandidateIds : 0,
    stableConfirm,
    newConfirm,
    lostConfirm,
    stableBlocked,
    newBlocked,
    resolvedBlocked,
  };
}
