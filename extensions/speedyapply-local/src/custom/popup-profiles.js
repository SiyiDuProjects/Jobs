// Only the worker owns Profile selection. This controller holds popup view state.
export function createPopupProfiles(api, changed) {
  let tabId,
    state,
    busy = false,
    revision = 0,
    disposed = false;
  function render(message = "", error = false) {
    if (!disposed)
      changed({
        ...state,
        busy,
        error,
        sourceLabel: state?.profileName
          ? state.bound === false
            ? "默认选择"
            : ["automatic", "resolved", "website"].includes(state.source)
            ? "自动切换"
            : "当前选择"
          : "",
        message:
          message ||
          (state?.available
            ? state.bound === false
              ? "此页面尚未绑定档案。这里显示最近手动选择的默认档案。"
              : "此档案已绑定当前标签页；其他岗位独立选择。"
            : "正在读取当前档案…"),
      });
  }
  async function request(action, kind) {
    const reply = await api.runtime.sendMessage({
      type: "jobs:popup-profile",
      action,
      tabId,
      kind,
      url: state?.url,
    });
    if (reply?.error || !reply?.data)
      throw Error(reply?.error || "插件未响应，请重试");
    return reply.data;
  }
  async function refresh() {
    const seq = ++revision;
    try {
      const next = await request("read");
      if (seq !== revision || busy || disposed) return;
      state = next;
      render();
    } catch (error) {
      if (seq === revision && !busy) render(error.message, true);
    }
  }
  async function choose(kind) {
    if (
      busy ||
      !state?.available ||
      kind === state.kind ||
      !state.choices?.[kind]
    )
      return;
    busy = true;
    const seq = ++revision;
    render("正在切换…");
    try {
      const next = await request("select", kind);
      if (seq !== revision || disposed) return;
      state = next;
      busy = false;
      render();
    } catch (error) {
      if (seq !== revision || disposed) return;
      busy = false;
      render(error.message, true);
    }
  }
  function storageChanged(changes, area) {
    if (
      !busy &&
      ((area === "session" &&
        (changes.jobsProfilesList || changes["profile_" + tabId])) ||
        (area === "local" && changes.jobsManualProfileDefault))
    )
      void refresh();
  }
  function activated(info) {
    tabId = info.tabId;
    state = null;
    busy = false;
    render();
    void refresh();
  }
  function updated(id, change) {
    if (id === tabId && change.url) activated({ tabId: id });
  }
  async function start() {
    api.storage.onChanged.addListener(storageChanged);
    api.tabs.onActivated.addListener(activated);
    api.tabs.onUpdated.addListener(updated);
    const seq = revision;
    try {
      const tabs = await api.tabs.query({ active: true, currentWindow: true });
      if (!disposed && seq === revision) activated({ tabId: tabs[0]?.id });
    } catch (error) {
      render(error.message, true);
    }
  }
  function dispose() {
    disposed = true;
    ++revision;
    api.storage.onChanged.removeListener(storageChanged);
    api.tabs.onActivated.removeListener(activated);
    api.tabs.onUpdated.removeListener(updated);
  }
  return { start, choose, dispose };
}
