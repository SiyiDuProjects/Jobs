const labels = {
  ready: "删除会停止该岗位的自动填写，可在 24 小时内撤销。",
  pending: "删除待同步，连接恢复后自动重试",
  removed: "已从岗位列表移除",
  already_removed: "该岗位已在回收站",
  restoring: "正在撤销删除…",
  restored: "岗位已恢复；不会自动继续填写。",
  unmatched: "未匹配到 jobs 岗位，未删除",
  expired: "操作已过期，请重新删除",
  protected:
    "此岗位有提交记录或提交结果待核实，未删除；若尚未提交，请检查服务是否已更新。",
  restore_expired: "已超过 24 小时恢复期限",
  restore_conflict: "岗位状态已变化，请到回收站查看",
};
export function createPopupJob(api, changed) {
  let tab,
    data,
    busy = false,
    reason = "",
    revision = 0,
    disposed = false;
  function view() {
    const undo =
      data?.state === "removed" && data.expires_at * 1000 > Date.now();
    const deleting = [
      "pending",
      "removed",
      "already_removed",
      "restoring",
      "restore_expired",
      "restore_conflict",
    ].includes(data?.state);
    const actionable =
      ["ready", "restored", "expired"].includes(data?.state) && !data?.error;
    return {
      busy,
      reason,
      undo,
      deleting,
      actionable,
      title: tab?.title || "当前页面",
      detail: data?.removal_detail || "未填写具体原因",
      label: undo
        ? "撤销删除"
        : ["removed", "already_removed"].includes(data?.state)
          ? "已删除"
          : "删除当前岗位",
      disabled:
        busy || !!data?.error || (!undo && (!actionable || !reason.trim())),
      message: busy
        ? "正在处理…"
        : data?.error ||
          data?.sync_error ||
          labels[data?.state] ||
          "正在读取当前页面…",
      loading: !data,
    };
  }
  function render() {
    if (!disposed) changed(view());
  }
  async function request(action) {
    if (!tab?.id || !/^https?:/.test(tab.url || ""))
      throw Error("请在招聘岗位页面使用");
    const reply = await api.runtime.sendMessage({
      type: "jobs:job-action",
      action,
      tabId: tab.id,
      url: tab.url,
      eventId: data?.event_id,
      ...(action === "delete" ? { detail: reason.trim() } : {}),
    });
    if (!reply || reply.error)
      throw Error(reply?.error || "插件未响应，请重试");
    return reply;
  }
  async function refresh() {
    const seq = ++revision;
    try {
      const next = await request("status");
      if (seq === revision && !busy && !disposed) {
        data = next;
        render();
      }
    } catch (error) {
      if (seq === revision && !busy) {
        data = { error: error.message };
        render();
      }
    }
  }
  async function select() {
    const seq = ++revision;
    busy = false;
    data = null;
    reason = "";
    render();
    try {
      const tabs = await api.tabs.query({ active: true, currentWindow: true });
      if (seq !== revision || disposed) return;
      [tab] = tabs;
      await refresh();
    } catch {
      if (seq !== revision || disposed) return;
      data = { error: "无法读取当前页面，请重新打开插件" };
      render();
    }
  }
  async function act() {
    if (view().disabled) return;
    const action = view().undo ? "restore" : "delete";
    busy = true;
    const seq = ++revision;
    render();
    try {
      const next = await request(action);
      if (seq !== revision || disposed) return;
      data = next;
    } catch (error) {
      if (seq !== revision || disposed) return;
      data = { error: error.message };
    } finally {
      if (seq === revision && !disposed) {
        busy = false;
        render();
        if (!data.error) void refresh();
      }
    }
  }
  function storageChanged(changes, area) {
    if (area === "local" && changes.jobsSyncV1 && !busy) void refresh();
  }
  function activated() {
    void select();
  }
  function updated(id, change) {
    if (id === tab?.id && change.url) void select();
  }
  function start() {
    api.storage.onChanged.addListener(storageChanged);
    api.tabs.onActivated.addListener(activated);
    api.tabs.onUpdated.addListener(updated);
    return select();
  }
  function dispose() {
    disposed = true;
    ++revision;
    api.storage.onChanged.removeListener(storageChanged);
    api.tabs.onActivated.removeListener(activated);
    api.tabs.onUpdated.removeListener(updated);
  }
  return {
    start,
    act,
    dispose,
    setReason(value) {
      reason = value;
      render();
    },
  };
}
