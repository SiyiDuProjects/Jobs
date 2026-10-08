import test from "node:test";
import assert from "node:assert/strict";
import { createRunState } from "../src/custom/run-state.js";
const root = { ownerDocument: { defaultView: { AbortController } } };
test("one AbortSignal cancels every consumer and cannot be resumed", () => {
  const { flow, controller } = createRunState(root);
  flow.move("verifying");
  flow.move("filling");
  let stopped = 0;
  controller.signal.addEventListener("abort", () => stopped++);
  const pending = () => !controller.signal.aborted;
  controller.abort("removed");
  controller.abort("again");
  assert.equal(pending(), false);
  assert.equal(stopped, 1);
  assert.equal(flow.state, "cancelled");
  assert.equal(controller.signal.reason, "removed");
  assert.throws(() => flow.move("verifying"));
});
test("cancellation cannot erase an attempted navigation or authorize a replay", () => {
  const { flow, controller } = createRunState(root);
  flow.move("verifying");
  flow.move("checking");
  flow.navigate("submit");
  controller.abort("pagehide");
  assert.equal(flow.snapshot().navigation, "submit");
  assert.throws(() => flow.navigate("submit"));
});
