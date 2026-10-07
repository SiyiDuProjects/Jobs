import { JobsControlFields } from "./control-fields.js";
export var JobsReviewPresenter;
let initialized = false;
export function initializeReviewPresenter() {
  if (initialized) return;
  initialized = true;
  if (globalThis.__jobsReviewPresenter) {
    JobsReviewPresenter = globalThis.__jobsReviewPresenter;
    return;
  }
  let last,
    transport = Promise.resolve();
  JobsReviewPresenter = Object.freeze({
    show(data) {
      const id = data?.id || last?.id;
      last = data;
      if (!id) return;
      transport = transport
        .catch(() => {})
        .then(async () => {
          const result = await chrome.runtime.sendMessage({
            type: "jobs:review-present",
            id,
            data,
          });
          if (result?.error) throw Error(result.error);
        })
        .catch(() => {});
    },
    pending: () => !!last,
    expand() {
      // Only called from a user gesture when continuation is blocked.
      void chrome.runtime
        .sendMessage({ type: "jobs:panel-open" })
        .catch(() => {});
    },
  });
  chrome.runtime.onMessage?.addListener((message, sender, reply) => {
    if (message?.type !== "jobs:review-view" || window !== window.top) return;
    if (sender.id !== chrome.runtime.id || sender.tab) {
      reply({ error: "Background only" });
      return;
    }
    if (message.data || last?.id === message.id) last = message.data;
    reply({ ok: true });
  });
  const block = (event) => {
    if (
      !last ||
      (event.type === "click" && !JobsControlFields?.continuation(event.target))
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.isTrusted) JobsReviewPresenter.expand();
  };
  document.addEventListener("click", block, true);
  document.addEventListener("submit", block, true);
  globalThis.__jobsReviewPresenter = JobsReviewPresenter;
}
