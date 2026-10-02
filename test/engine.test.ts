import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type ClassifierBackend,
  type ClassifierContextLike,
  classifyBatch,
} from "../src/engine.ts";
import { redactSecrets } from "../src/redaction.ts";

function backendFromProbabilities(
  probabilities: Record<string, number | "error" | "malformed" | "throw" | "aborted">,
  hooks: { onCall?: (id: string, context: ClassifierContextLike) => void; delayMs?: number } = {},
): ClassifierBackend {
  return {
    async selectModel() {
      return { provider: "fake", id: "jev", contextWindow: 1000 };
    },
    async classify(_model, context, options) {
      hooks.onCall?.(context.state.id, context);
      if (hooks.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, hooks.delayMs);
          options.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        });
      }
      const value = probabilities[context.state.id];
      if (value === "error") return { stopReason: "error", errorMessage: "provider failed", answers: {} };
      if (value === "malformed") return { stopReason: "stop", answers: { keep: { type: "choice" } } };
      if (value === "throw") throw new Error("transport failed");
      if (value === "aborted") return { stopReason: "aborted", errorMessage: "cancelled", answers: {} };
      return { stopReason: "stop", answers: { keep: { type: "bool", probability: value } } };
    },
  };
}

const baseOptions = {
  estimateTokens: (text: string) => Math.ceil(text.length / 4),
  redact: redactSecrets,
};

function ids(result: Awaited<ReturnType<typeof classifyBatch>>) {
  return [
    ...result.kept.map((x) => x.id),
    ...result.dropped.map((x) => x.id),
    ...result.undecided.map((x) => x.id),
    ...result.withheld.map((x) => x.id),
    ...result.errors.map((x) => x.id),
  ];
}

function assertExactAccounting(result: Awaited<ReturnType<typeof classifyBatch>>, expectedIds: string[]) {
  assert.equal(
    result.summary.total,
    result.summary.kept +
      result.summary.dropped +
      result.summary.undecided +
      result.summary.withheld +
      result.summary.errors,
  );
  assert.deepEqual([...ids(result)].sort(), [...expectedIds].sort());
  assert.equal(new Set(ids(result)).size, expectedIds.length);
}

test("basic classification keeps 0.90, undecides 0.50, drops 0.10", async () => {
  const result = await classifyBatch(
    {
      items: [
        { id: "high", text: "a" },
        { id: "mid", text: "b" },
        { id: "low", text: "c" },
      ],
      question: "keep?",
      threshold: 0.7,
    },
    backendFromProbabilities({ high: 0.9, mid: 0.5, low: 0.1 }),
    baseOptions,
  );
  assert.deepEqual(result.kept.map((x) => x.id), ["high"]);
  assert.deepEqual(result.undecided.map((x) => x.id), ["mid"]);
  assert.deepEqual(result.dropped.map((x) => x.id), ["low"]);
  assertExactAccounting(result, ["high", "mid", "low"]);
});

test("duplicate ids fail before classifier calls", async () => {
  let calls = 0;
  await assert.rejects(
    classifyBatch(
      {
        items: [
          { id: "dup", text: "a" },
          { id: "dup", text: "b" },
        ],
        question: "keep?",
      },
      backendFromProbabilities({ dup: 0.9 }, { onCall: () => calls++ }),
      baseOptions,
    ),
    /duplicate item id/,
  );
  assert.equal(calls, 0);
});

test("model selection failure preserves exact accounting", async () => {
  const backend: ClassifierBackend = {
    async selectModel() {
      throw new Error("no classifier auth");
    },
    async classify() {
      throw new Error("must not classify");
    },
  };
  const items = [{ id: "a", text: "one" }, { id: "b", text: "two" }];
  const result = await classifyBatch({ items, question: "keep?" }, backend, baseOptions);
  assert.equal(result.status, "error");
  assert.equal(result.summary.errors, 2);
  assert.ok(result.errors.every((x) => x.reason === "model_unavailable"));
  assertExactAccounting(result, items.map((x) => x.id));
});

test("classifier stopReason error is unresolved, never dropped", async () => {
  const result = await classifyBatch(
    { items: [{ id: "x", text: "a" }], question: "keep?" },
    backendFromProbabilities({ x: "error" }),
    baseOptions,
  );
  assert.equal(result.dropped.length, 0);
  assert.equal(result.errors[0]?.reason, "classifier_error");
  assertExactAccounting(result, ["x"]);
});

test("classifier errors never echo the full item text", async () => {
  const source = "distinctive candidate source text";
  const backend: ClassifierBackend = {
    async selectModel() {
      return { provider: "fake", id: "jev", contextWindow: 1000 };
    },
    async classify() {
      return { stopReason: "error", errorMessage: `provider rejected: ${source}`, answers: {} };
    },
  };
  const result = await classifyBatch(
    { items: [{ id: "x", text: source }], question: "keep?" },
    backend,
    baseOptions,
  );
  assert.equal(JSON.stringify(result).includes(source), false);
  assert.match(result.errors[0]?.message ?? "", /ITEM_TEXT_REDACTED/);
});

test("classifier error messages are secret-redacted before return", async () => {
  const backend: ClassifierBackend = {
    async selectModel() {
      return { provider: "fake", id: "jev", contextWindow: 1000 };
    },
    async classify() {
      return {
        stopReason: "error",
        errorMessage: "upstream echoed Bearer abcdefghijklmnopqrstuvwxyz123456",
        answers: {},
      };
    },
  };
  const result = await classifyBatch(
    { items: [{ id: "x", text: "safe" }], question: "keep?" },
    backend,
    baseOptions,
  );
  assert.equal(JSON.stringify(result).includes("abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(result.errors[0]?.reason, "classifier_error");
});

test("missing or malformed bool answer is an error", async () => {
  const result = await classifyBatch(
    { items: [{ id: "x", text: "a" }], question: "keep?" },
    backendFromProbabilities({ x: "malformed" }),
    baseOptions,
  );
  assert.equal(result.dropped.length, 0);
  assert.equal(result.errors[0]?.reason, "malformed_answer");
  assertExactAccounting(result, ["x"]);
});

test("too-large items are withheld before classifier calls", async () => {
  let calls = 0;
  const result = await classifyBatch(
    { items: [{ id: "big", text: "x".repeat(4000) }], question: "keep?" },
    backendFromProbabilities({ big: 0.9 }, { onCall: () => calls++ }),
    { ...baseOptions, contextSafetyFraction: 0.5 },
  );
  assert.equal(calls, 0);
  assert.deepEqual(result.withheld, [{ id: "big", reason: "too_large" }]);
  assertExactAccounting(result, ["big"]);
});

test("guard blocks 201 items with zero classifier calls and 199 runs", async () => {
  let calls = 0;
  const make = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, text: "ok" }));
  const probabilities = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`i${i}`, 0.9]));
  const backend = backendFromProbabilities(probabilities, { onCall: () => calls++ });

  const blocked = await classifyBatch({ items: make(201), question: "keep?" }, backend, baseOptions);
  assert.equal(blocked.status, "approval_required");
  assert.equal(calls, 0);
  assert.equal(blocked.summary.withheld, 201);
  assertExactAccounting(blocked, make(201).map((x) => x.id));

  const allowed = await classifyBatch({ items: make(199), question: "keep?" }, backend, baseOptions);
  assert.equal(allowed.status, "ok");
  assert.equal(calls, 199);
  assertExactAccounting(allowed, make(199).map((x) => x.id));
});

test("confirm=true permits a batch above the guard", async () => {
  let calls = 0;
  const items = Array.from({ length: 201 }, (_, i) => ({ id: `i${i}`, text: "ok" }));
  const probabilities = Object.fromEntries(items.map((x) => [x.id, 0.1]));
  const result = await classifyBatch(
    { items, question: "keep?", confirm: true },
    backendFromProbabilities(probabilities, { onCall: () => calls++ }),
    baseOptions,
  );
  assert.equal(calls, 201);
  assert.equal(result.summary.dropped, 201);
  assertExactAccounting(result, items.map((x) => x.id));
});

test("bounded concurrency never exceeds configured limit", async () => {
  let active = 0;
  let maxActive = 0;
  const items = Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, text: "ok" }));
  const backend: ClassifierBackend = {
    async selectModel() {
      return { provider: "fake", id: "jev", contextWindow: 1000 };
    },
    async classify(_model, context) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { stopReason: "stop", answers: { keep: { type: "bool", probability: Number(context.state.id.slice(1)) % 2 ? 0.9 : 0.1 } } };
    },
  };
  const result = await classifyBatch({ items, question: "keep?" }, backend, {
    ...baseOptions,
    concurrency: 4,
  });
  assert.ok(maxActive <= 4, `maxActive=${maxActive}`);
  assertExactAccounting(result, items.map((x) => x.id));
});

test("bucket ordering follows input order despite completion order", async () => {
  const items = [
    { id: "a", text: "a" },
    { id: "b", text: "b" },
    { id: "c", text: "c" },
    { id: "d", text: "d" },
  ];
  const backend: ClassifierBackend = {
    async selectModel() {
      return { provider: "fake", id: "jev", contextWindow: 1000 };
    },
    async classify(_model, context) {
      const delay = { a: 20, b: 1, c: 15, d: 2 }[context.state.id as "a" | "b" | "c" | "d"];
      await new Promise((resolve) => setTimeout(resolve, delay));
      return { stopReason: "stop", answers: { keep: { type: "bool", probability: 0.9 } } };
    },
  };
  const result = await classifyBatch({ items, question: "keep?" }, backend, { ...baseOptions, concurrency: 4 });
  assert.deepEqual(result.kept.map((x) => x.id), ["a", "b", "c", "d"]);
});

test("compact output never echoes source text", async () => {
  const secretText = "very distinctive source text that must not come back";
  const result = await classifyBatch(
    { items: [{ id: "x", text: secretText }], question: "keep?" },
    backendFromProbabilities({ x: 0.9 }),
    baseOptions,
  );
  assert.equal(JSON.stringify(result).includes(secretText), false);
});

test("redactor covers representative credential forms", () => {
  const bearer = "Authorization: Bearer " + "abcdefghijklmnopqrstuvwxyz123456";
  const apiKey = "api_key='" + "abcdefghijklmnopqrstuvwxyz123456" + "'";
  const anthropicLike = "token=" + ["sk", "ant", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
  const githubLike = ["github", "pat", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
  const awsLike = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
  const googleLike = "AI" + "za" + "abcdefghijklmnopqrstuvwxyz1234567890";
  const privateKey = [
    "-----BEGIN " + "PRIVATE KEY-----",
    "abc123secretmaterial",
    "-----END " + "PRIVATE KEY-----",
  ].join("\n");
  const samples = [bearer, apiKey, anthropicLike, githubLike, awsLike, googleLike, privateKey];
  for (const sample of samples) {
    const redacted = redactSecrets(sample);
    assert.ok(redacted.count >= 1, `expected redaction for ${sample.slice(0, 20)}`);
    assert.notEqual(redacted.text, sample);
  }
});

test("recognizable secrets are redacted before classifier payload", async () => {
  const observed: string[] = [];
  const result = await classifyBatch(
    {
      items: [
        { id: "x", text: "Authorization: Bearer " + "abcdefghijklmnopqrstuvwxyz123456" },
        { id: "y", text: "api_key=" + "sk-" + "supersecretabcdefghijklmnopqrstuvwxyz" },
      ],
      question: "keep?",
    },
    backendFromProbabilities(
      { x: 0.9, y: 0.9 },
      { onCall: (_id, context) => observed.push(context.state.text) },
    ),
    baseOptions,
  );
  assert.equal(observed.some((text) => text.includes("abcdefghijklmnopqrstuvwxyz123456")), false);
  assert.equal(observed.some((text) => text.includes("supersecret")), false);
  assert.equal(result.summary.redactedItems, 2);
  assert.ok(result.summary.redactionCount >= 2);
});

test("question and criteria are redacted before classifier payload", async () => {
  const observed: ClassifierContextLike[] = [];
  const questionSecret = "Bearer " + "questionsecretabcdefghijklmnop";
  const trueSecret = "api_key=" + "criterionsecretabcdefghijklmnop";
  const result = await classifyBatch(
    {
      items: [{ id: "x", text: "safe candidate" }],
      question: `keep when ${questionSecret}`,
      criteria: { true: `match ${trueSecret}`, false: "safe false criterion" },
    },
    backendFromProbabilities(
      { x: 0.9 },
      { onCall: (_id, context) => observed.push(context) },
    ),
    baseOptions,
  );
  const payload = JSON.stringify(observed);
  assert.equal(payload.includes("questionsecret"), false);
  assert.equal(payload.includes("criterionsecret"), false);
  assert.equal(result.summary.redactedItems, 0);
  assert.ok(result.summary.redactionCount >= 2);
});

test("already-aborted signal makes no model or classifier calls", async () => {
  const controller = new AbortController();
  controller.abort();
  let modelCalls = 0;
  let classifierCalls = 0;
  const backend: ClassifierBackend = {
    async selectModel() {
      modelCalls += 1;
      return { provider: "fake", id: "jev", contextWindow: 1000 };
    },
    async classify() {
      classifierCalls += 1;
      return { stopReason: "stop", answers: { keep: { type: "bool", probability: 0.9 } } };
    },
  };
  const result = await classifyBatch(
    { items: [{ id: "x", text: "safe" }], question: "keep?" },
    backend,
    { ...baseOptions, signal: controller.signal },
  );
  assert.equal(modelCalls, 0);
  assert.equal(classifierCalls, 0);
  assert.equal(result.errors[0]?.reason, "aborted");
  assertExactAccounting(result, ["x"]);
});

test("abort stops scheduling and unfinished items remain unresolved", async () => {
  const controller = new AbortController();
  const items = Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, text: "ok" }));
  let calls = 0;
  const backend = backendFromProbabilities(
    Object.fromEntries(items.map((x) => [x.id, 0.9])),
    { onCall: () => calls++, delayMs: 50 },
  );
  const promise = classifyBatch({ items, question: "keep?" }, backend, {
    ...baseOptions,
    concurrency: 3,
    signal: controller.signal,
  } as typeof baseOptions & { concurrency: number; signal: AbortSignal });
  setTimeout(() => controller.abort(), 5);
  const result = await promise;
  assert.ok(calls <= 3, `calls=${calls}`);
  assert.equal(result.dropped.length, 0);
  assert.ok(result.errors.every((x) => x.reason === "aborted"));
  assertExactAccounting(result, items.map((x) => x.id));
});

test("no .system1 or candidate scratch files are created", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-semantic-screen-test-"));
  const before = readdirSync(dir);
  try {
    await classifyBatch(
      { items: [{ id: "x", text: "ok" }], question: "keep?" },
      backendFromProbabilities({ x: 0.9 }),
      baseOptions,
    );
    const after = readdirSync(dir);
    assert.deepEqual(after, before);
    assert.equal(after.includes(".system1"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aggregates exact classifier usage when every call reports usage", async () => {
  const usage = {
    input: 10,
    output: 2,
    cacheRead: 3,
    cacheWrite: 1,
    totalTokens: 16,
    cost: { input: 0.001, output: 0.002, cacheRead: 0.0003, cacheWrite: 0.0001, total: 0.0034 },
  };
  const backend: ClassifierBackend = {
    async selectModel() {
      return { provider: "fake", id: "jev", contextWindow: 1000 };
    },
    async classify(_model, context) {
      return {
        stopReason: "stop",
        answers: { keep: { type: "bool", probability: context.state.id === "a" ? 0.9 : 0.1 } },
        usage,
      };
    },
  };
  const result = await classifyBatch(
    { items: [{ id: "a", text: "x" }, { id: "b", text: "y" }], question: "keep?" },
    backend,
    baseOptions,
  );
  assert.deepEqual(result.classifierAccounting, {
    calls: 2,
    usageReportedCalls: 2,
    complete: true,
    usage: {
      input: 20,
      output: 4,
      cacheRead: 6,
      cacheWrite: 2,
      totalTokens: 32,
      cost: { input: 0.002, output: 0.004, cacheRead: 0.0006, cacheWrite: 0.0002, total: 0.0068 },
    },
  });
});

test("marks classifier usage incomplete when any call omits usage", async () => {
  const backend: ClassifierBackend = {
    async selectModel() {
      return { provider: "fake", id: "jev", contextWindow: 1000 };
    },
    async classify(_model, context) {
      return {
        stopReason: "stop",
        answers: { keep: { type: "bool", probability: 0.9 } },
        ...(context.state.id === "a" ? {
          usage: {
            input: 10,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 11,
            cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
          },
        } : {}),
      };
    },
  };
  const result = await classifyBatch(
    { items: [{ id: "a", text: "x" }, { id: "b", text: "y" }], question: "keep?" },
    backend,
    baseOptions,
  );
  assert.equal(result.classifierAccounting?.calls, 2);
  assert.equal(result.classifierAccounting?.usageReportedCalls, 1);
  assert.equal(result.classifierAccounting?.complete, false);
  assert.equal(result.classifierAccounting?.usage?.totalTokens, 11);
});
