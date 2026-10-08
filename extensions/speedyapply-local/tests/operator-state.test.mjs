import test from "node:test";
import assert from "node:assert/strict";
import { createOperatorState } from "../src/custom/operator-state.js";

test("unknown ownership cannot learn; hand-back invalidates earlier captures", () => {
  const state = createOperatorState();
  assert.equal(state.canLearn(), false);
  state.update({ mode: "person", epoch: "first" });
  assert.equal(state.canLearn("first"), true);
  state.update({ mode: "agent", epoch: "second", since: 1 });
  assert.equal(state.canLearn("first"), false);
  assert.equal(
    state.canLearn(),
    false,
    "an old timestamp never restores human ownership",
  );
  state.update({ mode: "person", epoch: "third" });
  assert.equal(state.canLearn("first"), false);
  assert.equal(state.canLearn("third"), true);
  assert.equal(state.update({ mode: "person" }), false);
});

test("page tools cannot become learnable input", () => {
  const state = createOperatorState();
  state.update({ mode: "page-tool", epoch: "page" });
  assert.equal(state.canLearn(), false);
});
