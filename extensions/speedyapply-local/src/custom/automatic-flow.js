// Run transitions and the non-replayable navigation latch.
const transitions = Object.freeze({
  created: ["verifying"],
  verifying: ["filling", "checking", "review"],
  filling: ["scanning", "review"],
  scanning: ["resolving", "writing", "checking", "review"],
  resolving: ["writing", "scanning", "checking", "review"],
  writing: ["resolving", "scanning", "checking", "review"],
  review: ["verifying", "checking"],
  checking: ["scanning", "review", "complete", "navigation-attempted"],
  complete: [],
  blocked: [],
  cancelled: [],
  "navigation-attempted": [],
});
export function createFlow(onTransition = (_from, _to) => {}) {
  let state = "created",
    navigation = null;
  const history = [];
  const terminal = () =>
    ["complete", "blocked", "cancelled", "navigation-attempted"].includes(
      state,
    );
  function move(next) {
    if (next === state) return;
    if (!transitions[state]?.includes(next))
      throw Error(`Invalid fill transition: ${state} -> ${next}`);
    const before = state;
    state = next;
    history.push({ from: before, to: next });
    if (history.length > 80) history.shift();
    onTransition(before, next);
  }
  function stop(next) {
    if (terminal()) return false;
    const before = state;
    state = next;
    history.push({ from: before, to: next });
    onTransition(before, next);
    return true;
  }
  return Object.freeze({
    move,
    get state() {
      return state;
    },
    navigate(action) {
      if (
        state !== "checking" ||
        navigation ||
        !["next", "submit"].includes(action)
      )
        throw Error("Navigation cannot be replayed");
      // Journal the attempt before invoking a click. A thrown click or lost
      // acknowledgement is uncertain; it must never reset this latch.
      navigation = action;
      move("navigation-attempted");
    },
    block: () => stop("blocked"),
    cancel: () => stop("cancelled"),
    snapshot: () => ({
      state,
      navigation,
      history: history.map((entry) => ({ ...entry })),
    }),
  });
}
