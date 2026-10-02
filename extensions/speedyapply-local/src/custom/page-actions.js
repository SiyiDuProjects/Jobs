import { JobsQueuePage } from "./queue-page.js";
import { JobsFormPipeline } from "./form-pipeline.js";
export var JobsPageActions;
let initialized = false;
export function initializePageActions() {
  if (initialized) return;
  initialized = true;
  (() => {
    const allowed = () =>
      JobsQueuePage?.allowed() !== false &&
      JobsFormPipeline?.live?.() !== false;
    // Bind a caller's liveness check to the queue operation current at entry,
    // so a pause followed by resume never revives an older asynchronous write.
    const guard = (check) => JobsQueuePage?.guard(check) || check;
    const live = (check) => allowed() && check();
    const when = (action) => allowed() && action();
    const click = (node) => allowed() && (node.click(), true);
    const dispatch = (node, event) => allowed() && node.dispatchEvent(event);
    JobsPageActions = Object.freeze({
      allowed,
      guard,
      live,
      when,
      click,
      dispatch,
    });
  })();
}
