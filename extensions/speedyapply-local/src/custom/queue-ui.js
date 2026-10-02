(() => {
  const names = {
    queued: "待开始",
    opening: "正在打开",
    entering: "进入表单",
    filling: "正在填写",
    waiting_input: "等待处理",
    ready: "已填好，未提交",
    paused: "已暂停",
    blocked: "需要核对",
    submission_uncertain: "提交结果待核实",
    confirmed: "ATS 已确认",
    cancelled: "已取消",
  };
  const mode = /** @type {HTMLSelectElement} */ (
    document.getElementById("mode")
  );
  const list = document.getElementById("items"),
    status = document.getElementById("status");
  let busy = false;
  function render(state) {
    status.textContent = state.enabled ? "队列已开启" : "队列已暂停";
    mode.value = state.mode;
    document.getElementById("empty").hidden = state.items.length > 0;
    list.replaceChildren();
    for (const item of state.items) {
      const li = document.createElement("li"),
        title = document.createElement("h2"),
        label = document.createElement("span"),
        reason = document.createElement("p");
      title.textContent =
        [item.company, item.title].filter(Boolean).join(" · ") || "岗位";
      label.className = "state";
      label.textContent =
        (item.paused ? "已暂停 · " : "") + (names[item.state] || item.state);
      reason.textContent = item.reason || "";
      li.append(title, label, reason);
      const action = (name, text) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = text;
        button.onclick = () => send(name, { id: item.id });
        li.append(button);
      };
      if (item.tabId) action("open", "打开原页面");
      if (
        !["confirmed", "cancelled", "submission_uncertain"].includes(item.state)
      ) {
        if (
          item.tabId &&
          (item.paused ||
            ["blocked", "waiting_input", "ready"].includes(item.state))
        )
          action("resume", "继续此岗位");
        else if (["opening", "entering", "filling"].includes(item.state))
          action("pause_item", "暂停此岗位");
        action("cancel", "取消排队");
      }
      list.append(li);
    }
  }
  async function send(action, args = {}) {
    if (busy) return;
    busy = true;
    try {
      const result = await chrome.runtime.sendMessage({
        type: "jobs:queue",
        action,
        args,
      });
      if (result.error) throw Error(result.error);
      render(result.data);
    } catch (error) {
      status.textContent = error.message || "暂时无法读取队列";
    } finally {
      busy = false;
    }
  }
  document.getElementById("start").onclick = () =>
    send("start", { mode: mode.value });
  document.getElementById("pause").onclick = () => send("pause");
  const timer = setInterval(() => {
    if (document.visibilityState === "visible") void send("read");
  }, 5000);
  window.addEventListener("pagehide", () => clearInterval(timer), {
    once: true,
  });
  void send("read");
})();
