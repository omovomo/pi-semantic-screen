export interface ScreeningPreflightResult {
  status: "ok" | "approval_required";
  projectedCalls: number;
  callLimit: number;
}

export function screeningPreflight(count: number, callLimit: number): ScreeningPreflightResult {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("count must be a positive integer");
  }
  if (!Number.isInteger(callLimit) || callLimit < 1) {
    throw new Error("callLimit must be a positive integer");
  }
  return {
    status: count > callLimit ? "approval_required" : "ok",
    projectedCalls: count,
    callLimit,
  };
}
