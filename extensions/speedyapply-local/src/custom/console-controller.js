// The answer console follows every application tab. Each page change is
// announced by the worker (jobs:panel-changed); tab lifecycle events and a slow
// heartbeat cover pages that change without a status report.
export function createConsoleController(api, changed) {
  let disposed = false,
    timer,
    heartbeat,
    reading,
    queued = false,
    full = false,
    rows = [];
  const dirty = new Set(),
    actions = new Map();
  function refresh(tabIds) {
    if (reading) {
      if (tabIds) {
        tabIds.forEach((id) => dirty.add(id));
        queued = true;
      }
      return reading;
    }
    reading = (async () => {
      try {
        const result = await api.runtime.sendMessage({
          type: "jobs:console-read",
          ...(tabIds ? { tabIds } : {}),
        });
        if (disposed) return;
        if (result?.error) throw Error(result.error);
        const incoming = result?.data?.tabs || [];
        rows = tabIds
          ? [...rows.filter((row) => !tabIds.includes(row.tabId)), ...incoming]
          : incoming;
        changed({ rows, error: "", loaded: true });
      } catch (error) {
        if (!disposed)
          changed({
            rows,
            error: error.message || "无法读取投递页面",
            loaded: true,
          });
      } finally {
        reading = undefined;
        if (queued) {
          queued = false;
          schedule(60);
        }
      }
    })();
    return reading;
  }
  const schedule = (delay = 120) => {
    if (disposed) return;
    if (reading) {
      queued = true;
      return;
    }
    // One bounded debounce, even while dozens of tabs keep reporting changes.
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      const tabIds = full || !dirty.size ? undefined : [...dirty];
      full = false;
      dirty.clear();
      void refresh(tabIds);
    }, delay);
  };
  const message = (data, sender) => {
    if (sender.id === api.runtime.id && data?.type === "jobs:panel-changed") {
      if (Number.isInteger(data.tabId)) dirty.add(data.tabId);
      else full = true;
      schedule();
    }
  };
  const tabRemoved = () => {
    full = true;
    schedule(60);
  };
  const tabUpdated = (id, change) => {
    if (change.url || change.status === "complete" || change.title) {
      dirty.add(id);
      schedule(400);
    }
  };
  const send = async (message) => {
    try {
      return (
        (await api.runtime.sendMessage(message)) || {
          error: "页面没有回应，请跳到网页检查。",
        }
      );
    } catch (error) {
      return { error: error.message || "页面已关闭或无法连接，请检查原网页。" };
    } finally {
      if (Number.isInteger(message.tabId)) dirty.add(message.tabId);
      schedule(60);
    }
  };
  return {
    start() {
      api.runtime.onMessage.addListener(message);
      api.tabs.onRemoved.addListener(tabRemoved);
      api.tabs.onUpdated.addListener(tabUpdated);
      heartbeat = setInterval(() => {
        full = true;
        schedule(0);
      }, 15000);
      return refresh();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      api.runtime.onMessage.removeListener(message);
      api.tabs.onRemoved.removeListener(tabRemoved);
      api.tabs.onUpdated.removeListener(tabUpdated);
    },
    refresh,
    // One versioned command for the page that showed this review.
    act(row, action, itemId, payload) {
      if (!row?.review)
        return Promise.resolve({ error: "这一页没有待确认的答案。" });
      const key = `${row.tabId}:${row.review.documentId}:${row.review.id}:${action}:${itemId || ""}`;
      if (actions.has(key)) return actions.get(key);
      const task = send({
        type: "jobs:review-action",
        tabId: row.tabId,
        id: row.review.id,
        documentId: row.review.documentId,
        action,
        itemId,
        payload,
      }).finally(() => actions.delete(key));
      actions.set(key, task);
      return task;
    },
    // The page's own "prepare answers": fill this form and open its review.
    prepare(row) {
      if (!row?.status?.canFill)
        return Promise.resolve({ error: "这一页暂时不能准备回答。" });
      return send({
        type: "jobs:panel-status-action",
        tabId: row.tabId,
        id: row.status.id,
        action: "draft",
      });
    },
    // Bring the already-open tab forward; never reopen its link.
    focus(row, itemId) {
      return send({
        type: "jobs:console-focus",
        tabId: row.tabId,
        ...(row.review && typeof itemId === "string"
          ? {
              itemId,
              reviewId: row.review.id,
              documentId: row.review.documentId,
            }
          : {}),
      });
    },
  };
}
