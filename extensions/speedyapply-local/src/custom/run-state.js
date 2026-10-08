import { createFlow } from "./automatic-flow.js";
// One cancellation identity for the lifetime of a form run, shared by its
// operation context, pending writers and continuation. Navigation is never reset.
export function createRunState(root, onTransition) {
  const flow = createFlow(onTransition);
  const controller = new root.ownerDocument.defaultView.AbortController();
  controller.signal.addEventListener("abort", () => flow.cancel(), {
    once: true,
  });
  return { flow, controller };
}
