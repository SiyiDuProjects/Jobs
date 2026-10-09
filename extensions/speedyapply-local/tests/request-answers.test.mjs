import test from "node:test";
import assert from "node:assert/strict";
import { requestAnswerBatch } from "../src/custom/request-answers.js";
import { historyEventMetrics } from "../src/custom/history-event-metrics.js";

const usage = { fieldCount: 1, cacheHits: 1, modelFields: 0, modelCalls: 0 };
const message = { fields: [{ fieldId: "f", required: true }] };
const answers = [{ fieldId: "f", state: "answer", value: "current-id" }];
for (const mode of [
  "success",
  "server-failure",
  "transport-failure",
  "invalid",
  "optional",
]) {
  test(`batch usage survives ${mode} without changing answer policy`, async () => {
    globalThis.chrome = {
      runtime: {
        sendMessage: async () => {
          if (mode === "transport-failure") throw Error("transport");
          if (["server-failure", "optional"].includes(mode))
            return { error: "failed", answerUsage: usage };
          return {
            data: {
              answers: mode === "invalid" ? [] : answers,
              answerUsage: usage,
            },
          };
        },
      },
    };
    const records = [];
    const pending = requestAnswerBatch(
      mode === "optional"
        ? { fields: [{ fieldId: "f", required: false }] }
        : message,
      (value) => records.push(value),
    );
    if (mode === "success") assert.deepEqual(await pending, answers);
    else if (mode === "optional")
      assert.equal((await pending)[0].state, "needs_input");
    else await assert.rejects(pending);
    assert.deepEqual(records, [
      mode === "transport-failure" ? { unavailable: true } : usage,
    ]);
  });
}
test("telemetry failure does not block a valid answer", async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: async () => ({ data: { answers, answerUsage: usage } }),
    },
  };
  assert.deepEqual(
    await requestAnswerBatch(message, () => {
      throw Error("journal");
    }),
    answers,
  );
});
test("usage metrics allow only bounded integers and never carry private payloads", () => {
  assert.deepEqual(
    historyEventMetrics("auto_answer_batch", {
      ...usage,
      answer: "PRIVATE",
      url: "PRIVATE",
    }),
    { answerUsage: usage },
  );
  for (const invalid of [
    null,
    "{broken",
    {},
    { ...usage, cacheHits: true },
    { ...usage, fieldCount: 31 },
    { ...usage, modelCalls: 3 },
    { ...usage, modelFields: 1 },
    { unavailable: true, answer: "PRIVATE" },
  ])
    assert.deepEqual(historyEventMetrics("auto_answer_batch", invalid), {
      answerUsage: { unavailable: true },
    });
  assert.deepEqual(historyEventMetrics("other", usage), {});
});
