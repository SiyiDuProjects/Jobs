// InputEvent.isTrusted identifies browser input, not who operated the browser.
// Expiry is informational: only an explicit hand-back may resume learning.
export function createOperatorState() {
  const listeners = new Set();
  let state = { mode: "unknown", epoch: "", since: 0 };
  return Object.freeze({
    read: () => ({ ...state }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(next) {
      if (
        !["person", "agent", "page-tool"].includes(next?.mode) ||
        typeof next.epoch !== "string" ||
        !next.epoch
      )
        return false;
      state = { mode: next.mode, epoch: next.epoch, since: next.since || 0 };
      for (const listener of listeners) listener();
      return true;
    },
    canLearn: (epoch = state.epoch) =>
      state.mode === "person" && epoch === state.epoch,
  });
}

export const JobsOperator = createOperatorState();
export async function connectOperator() {
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (
      message?.type !== "jobs:operator-changed" ||
      sender.id !== chrome.runtime.id ||
      sender.tab
    )
      return;
    JobsOperator.update(message.state);
    reply({ ok: true });
  });
  try {
    const result = await chrome.runtime.sendMessage({
      type: "jobs:operator-read",
    });
    if (result?.state) JobsOperator.update(result.state);
  } catch {
    /* Unknown ownership disables learning, never form filling. */
  }
}

export async function claimAgentOperator(mode = "agent") {
  const result = await chrome.runtime.sendMessage({
    type: "jobs:operator-set",
    mode,
  });
  if (result?.error || !JobsOperator.update(result?.state))
    throw Error("无法确认操作模式，请重试。");
  return JobsOperator.read();
}
