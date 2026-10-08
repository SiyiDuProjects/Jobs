import { fixtureAnswers, explicitReply } from "./fixture-provider.mjs";
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
const transports = new WeakMap();
// Old component fixtures now exercise the sole runtime answer stage. Only the
// Profile/provider transport is replaced; resolution and writing are real.
export function runAnswerStage(w, options) {
  w.chrome ||= {};
  w.chrome.runtime ||= {};
  if (!loaded.has(w)) {
    scripts.forEach((code) => w.eval(code));
    loaded.add(w);
  }
  const current = w.chrome?.runtime?.sendMessage;
  const installed = transports.get(w);
  const old =
    installed && installed.wrapped === current ? installed.previous : current;
  w.chrome ||= {};
  w.chrome.runtime ||= {};
  w.chrome.runtime.sendMessage = async (message) =>
    message.type === "jobs:tab-profile"
      ? { data: { id: "fixture", profile: options.profile } }
      : old
        ? old(message)
        : {
            data: {
              answers: (message.fields || []).map((field) =>
                explicitReply(
                  w.JobsProfileAnswers,
                  field,
                  options.profile,
                  options.replies || [],
                  [...message.fields, ...(message.formContext || [])],
                ),
              ),
            },
          };
  transports.set(w, { previous: old, wrapped: w.chrome.runtime.sendMessage });
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
