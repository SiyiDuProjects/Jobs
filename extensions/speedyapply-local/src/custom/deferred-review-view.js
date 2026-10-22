// Content scripts keep their form/runtime logic independent of the editor's
// React bundle. Importing this packaged module runs in the isolated world.
/** @param {() => Promise<{createReviewView: typeof import("./review-view.js").createReviewView}>} importModule */
export function createReviewLoader(importModule) {
  let pending;
  return () => {
    pending ||= Promise.resolve()
      .then(importModule)
      .then((module) => {
        if (typeof module.createReviewView !== "function")
          throw Error("Review UI unavailable");
        return module.createReviewView;
      })
      .catch((error) => {
        pending = undefined;
        throw error;
      });
    return pending;
  };
}
export const loadReviewView = createReviewLoader(
  () => import(chrome.runtime.getURL("custom/review-ui.js")),
);
