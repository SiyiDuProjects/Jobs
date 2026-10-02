import { readWithDependencies } from "./runtime-source.mjs";
const scripts = await Promise.all(
  [
    "answer-memory",
    "review-presenter",
    "ai-review",
    "operation-context",
    "automatic-fill",
  ].map((name) =>
    readWithDependencies(
      new URL("../../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
const loaded = new WeakSet();
// Old component fixtures now exercise the sole runtime answer stage. Only the
// Profile/provider transport is replaced; resolution and writing are real.
export function runAnswerStage(w, options) {
  w.chrome ||= {};
  w.chrome.runtime ||= {};
  if (!loaded.has(w)) {
    scripts.forEach((code) => w.eval(code));
    loaded.add(w);
  }
  const old = w.chrome?.runtime?.sendMessage;
  w.chrome ||= {};
  w.chrome.runtime ||= {};
  w.chrome.runtime.sendMessage = async (message) =>
    message.type === "jobs:tab-profile"
      ? { data: { id: "fixture", profile: options.profile } }
      : old
        ? old(message)
        : { data: { answers: [] } };
  const root =
    options.root.nodeType === 9
      ? options.root.querySelector("form") || options.root.body
      : options.root;
  return w.JobsAutomatic.advance({
    ...options,
    root,
    action: "fill",
    retry: true,
  });
}
