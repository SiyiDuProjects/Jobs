export var JobsDOMWait;
let initialized = false;
export function initializeDomWait() {
  if (initialized) return;
  initialized = true;
  (() => {
    // Yield behind queued page work without chaining DOM timers. A hidden tab
    // can defer even a zero-delay timer for a minute. Background *priority*
    // lets ordinary framework tasks run first; scheduler.yield/MessageChannel
    // can overtake their renders, and RAF stops while hidden. This task has no
    // delay and is not a save acknowledgement: callers still verify the result.
    /** @returns {Promise<void>} */
    function task(view = window) {
      if (typeof view.scheduler?.postTask === "function")
        return view.scheduler.postTask(() => {}, { priority: "background" });
      return new Promise((resolve) => {
        view.setTimeout(resolve, 0);
      });
    }
    // interval: how often a quiet page is re-read (a condition that depends on
    // elapsed time, not only on DOM changes).
    /** @template T @param {()=>T} read @param {{root?:Document|Element|ShadowRoot,timeout?:number|null,signal?:AbortSignal,interval?:number}} [options] */
    function until(
      read,
      { root = document, timeout = null, signal, interval = 1000 } = {},
    ) {
      return new Promise((resolve, reject) => {
        const doc = /** @type {Document} */ (root.ownerDocument || root);
        const view = doc.defaultView || window;
        let observer,
          pollTimer,
          deadlineTimer,
          settled = false;
        const events = /** @type {Array<[EventTarget,string]>} */ ([
          [doc, "input"],
          [doc, "change"],
          [doc, "visibilitychange"],
          [doc, "resume"],
          [view, "pageshow"],
        ]);
        function cleanup() {
          observer?.disconnect();
          view.clearTimeout(pollTimer);
          view.clearTimeout(deadlineTimer);
          for (const [target, event] of events)
            target.removeEventListener(event, check, true);
          signal?.removeEventListener("abort", abort);
        }
        function finish(value, error) {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve(value);
        }
        function abort() {
          finish(null);
        }
        function check() {
          if (settled) return;
          try {
            const value = read();
            if (value) finish(value);
          } catch (error) {
            finish(null, error);
          }
        }
        function poll() {
          check();
          if (!settled) pollTimer = view.setTimeout(poll, interval);
        }
        if (signal?.aborted) {
          abort();
          return;
        }
        try {
          observer = new view.MutationObserver(check);
          observer.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          });
          for (const [target, event] of events)
            target.addEventListener(event, check, true);
          signal?.addEventListener("abort", abort, { once: true });
          check();
          if (settled) return;
          if (timeout !== null)
            deadlineTimer = view.setTimeout(() => {
              // A throttled timer may fire after the target became ready. Inspect
              // the current DOM before reporting a timeout, including after resume.
              check();
              if (!settled) finish(null);
            }, timeout);
          pollTimer = view.setTimeout(poll, interval);
        } catch (error) {
          finish(null, error);
        }
      });
    }
    JobsDOMWait = { until, task };
  })();
}
