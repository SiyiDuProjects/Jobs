import { createPageReview } from "./page-review.js";
import { JobsOperator, claimAgentOperator } from "./operator-state.js";
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
  const page = createPageReview({
    operator: JobsOperator,
    claim: claimAgentOperator,
  });
  let last,
    transport = Promise.resolve();
  JobsReviewPresenter = Object.freeze({
    show(data, action) {
      page.show(data, action);
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
    status(data, action) {
      page.status(data, action);
    },
    pending: () => !!last,
    expand() {
      if (["agent", "page-tool"].includes(JobsOperator.read().mode)) {
        page.expand();
        return;
      }
      // Only called from a user gesture when continuation is blocked.
      void chrome.runtime
        .sendMessage({ type: "jobs:panel-open" })
        .catch(() => {});
    },
  });
  chrome.runtime.onMessage?.addListener((message, sender, reply) => {
    if (
      !["jobs:review-view", "jobs:page-status"].includes(message?.type) ||
      window !== window.top
    )
      return;
    if (sender.id !== chrome.runtime.id || sender.tab) {
      reply({ error: "Background only" });
      return;
    }
    if (message.type === "jobs:page-status") {
      page.status(message.data, (action) =>
        chrome.runtime.sendMessage({
          type: "jobs:page-status-action",
          id: message.data.id,
          documentId: message.data.documentId,
          action,
        }),
      );
      reply({ ok: true });
      return;
    }
    if (message.data || last?.id === message.id) {
      last = message.data;
      page.show(last, (action, itemId, payload) =>
        chrome.runtime.sendMessage({
          type: "jobs:review-page-action",
          id: message.id,
          documentId: message.sourceDocumentId,
          action,
          itemId,
          payload,
        }),
      );
    }
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
