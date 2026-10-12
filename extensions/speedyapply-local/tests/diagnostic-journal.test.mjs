import test from "node:test";
import assert from "node:assert/strict";
import { createEventStream } from "../src/custom/event-stream.js";
import {
  diagnosticGuard,
  diagnosticEvidence,
} from "../src/custom/diagnostic-evidence.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));
test("journal preserves same-millisecond events and old runs until durable acknowledgement", async () => {
  let runId = "first",
    acknowledge;
  const reports = [];
  const journal = createEventStream({
    context: () => ({ runId }),
    defer: setTimeout,
    cancel: clearTimeout,
    send: async (report) => {
      reports.push(report);
      if (reports.length === 1) await new Promise((r) => (acknowledge = r));
      return { data: { ok: true } };
    },
  });
  journal.append({
    at: 1,
    type: "fill_trace",
    trace: { result: "no-options" },
  });
  journal.append({ at: 1, type: "fill_trace", trace: { result: "committed" } });
  await settle();
  runId = "second";
  journal.append({ at: 2, type: "phase" });
  assert.equal(journal.status().pending, 3);
  acknowledge();
  await settle();
  assert.equal(journal.status().pending, 0);
  assert.deepEqual(
    reports.map((r) => [r.runId, r.events.map((e) => e.sequence)]),
    [
      ["first", [1, 2]],
      ["second", [1]],
    ],
  );
  journal.clear();
});
test("missing or failed acknowledgements retain evidence and report overflow instead of success", async () => {
  let retry,
    ok = false;
  const journal = createEventStream({
    context: () => ({ runId: "one" }),
    defer: (fn) => {
      retry = fn;
      return 1;
    },
    cancel() {},
    send: async () => (ok ? { ok: true } : { error: "storage unavailable" }),
  });
  for (let i = 0; i < 520; i++) journal.append({ at: i, type: "phase" });
  await settle();
  assert.equal(journal.status().pending, 512);
  assert.equal(journal.status().dropped, 8);
  assert.equal(journal.status().error, "capture_unacknowledged");
  ok = true;
  retry();
  await settle();
  assert.equal(journal.status().pending, 0);
  assert.equal(journal.status().dropped, 8);
  journal.clear();
});
test("guard explains the first failed condition without changing evaluation order or throwing from diagnostics", () => {
  const calls = [],
    evidence = [];
  let valid = false;
  const check = diagnosticGuard(
    [
      [
        "user_input",
        () => {
          calls.push(1);
          return valid;
        },
      ],
      [
        "expired",
        () => {
          calls.push(2);
          return false;
        },
      ],
    ],
    (e) => {
      evidence.push(e);
      throw Error("recording failed");
    },
  );
  assert.equal(check(), false);
  assert.equal(check(), false);
  assert.deepEqual(calls, [1, 1]);
  assert.equal(evidence.length, 1);
  valid = true;
  assert.equal(check(), false);
  assert.equal(evidence[1].reason, "expired");
  assert.deepEqual(
    diagnosticEvidence({
      stage: "guard",
      reason: "PRIVATE_ANSWER",
      detail: "TOKEN",
      item: 3,
      hidden: true,
    }),
    { stage: "guard", item: 3, hidden: true },
  );
});
