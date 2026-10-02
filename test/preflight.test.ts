import assert from "node:assert/strict";
import test from "node:test";
import { screeningPreflight } from "../src/preflight.ts";

test("preflight allows counts at or below the configured limit", () => {
  assert.deepEqual(screeningPreflight(200, 200), {
    status: "ok",
    projectedCalls: 200,
    callLimit: 200,
  });
});

test("preflight requires approval above the configured limit", () => {
  assert.deepEqual(screeningPreflight(524, 200), {
    status: "approval_required",
    projectedCalls: 524,
    callLimit: 200,
  });
});

test("preflight rejects invalid counts and limits", () => {
  assert.throws(() => screeningPreflight(0, 200), /count must be a positive integer/);
  assert.throws(() => screeningPreflight(10, 0), /callLimit must be a positive integer/);
});
