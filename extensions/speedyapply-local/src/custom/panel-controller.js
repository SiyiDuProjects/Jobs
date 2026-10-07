// A long-lived side panel follows only the active tab in its own window.
export function createPanelController(api, changed) {
  let tab,
    windowId,
    disposed = false,
    revision = 0;
  function empty(text = "正在读取投递状态…") {
    changed({ text, review: null, status: null });
  }
  async function refresh() {
    const seq = ++revision,
      owner = tab;
    if (!owner?.id) {
      empty("打开招聘岗位后，这里会显示投递进度。");
      return;
    }
    try {
      const result = await api.runtime.sendMessage({
        type: "jobs:panel-read",
        tabId: owner.id,
      });
      if (disposed || seq !== revision || tab !== owner) return;
      if (result?.error) throw Error(result.error);
      changed({
        text:
          result?.status?.text ||
          (result?.review ? "等待你确认答案" : "当前页面暂无投递进度"),
        status: result?.status,
        review: result?.review,
        act: async (action, itemId, payload) => {
          if (disposed || tab !== owner || !result.review)
            return { error: "页面已切换，请检查当前岗位。" };
          return api.runtime.sendMessage({
            type: "jobs:review-action",
            tabId: owner.id,
            id: result.review.id,
            documentId: result.review.documentId,
            action,
            itemId,
            payload,
          });
        },
        statusAction: async (action) => {
          if (disposed || tab !== owner || !result.status) return;
          const reply = await api.runtime.sendMessage({
            type: "jobs:panel-status-action",
            tabId: owner.id,
            id: result.status.id,
            action,
          });
          if (tab !== owner || disposed) return;
          if (reply?.error) throw Error(reply.error);
          await refresh();
        },
      });
    } catch (error) {
      if (!disposed && seq === revision)
        empty(error.message || "无法读取投递状态，请重新打开侧边栏。");
    }
  }
  async function select(info) {
    if (
      windowId != null &&
      info?.windowId != null &&
      info.windowId !== windowId
    )
      return;
    const seq = ++revision;
    tab = null;
    empty();
    try {
      const tabs = await api.tabs.query(
        windowId == null
          ? { active: true, currentWindow: true }
          : { active: true, windowId },
      );
      if (disposed || seq !== revision) return;
      [tab] = tabs;
      windowId = tab?.windowId ?? windowId;
      await refresh();
    } catch {
      if (!disposed && seq === revision) empty("无法读取当前页面");
    }
  }
  const message = (data, sender) => {
    if (
      sender.id === api.runtime.id &&
      !sender.tab &&
      data?.type === "jobs:panel-changed" &&
      data.tabId === tab?.id
    )
      void refresh();
  };
  const activated = (info) => {
    void select(info);
  };
  const updated = (id, change) => {
    if (id === tab?.id && (change.url || change.status === "loading"))
      void select();
  };
  return {
    start() {
      api.runtime.onMessage.addListener(message);
      api.tabs.onActivated.addListener(activated);
      api.tabs.onUpdated.addListener(updated);
      return select(undefined);
    },
    dispose() {
      disposed = true;
      ++revision;
      api.runtime.onMessage.removeListener(message);
      api.tabs.onActivated.removeListener(activated);
      api.tabs.onUpdated.removeListener(updated);
    },
  };
}
