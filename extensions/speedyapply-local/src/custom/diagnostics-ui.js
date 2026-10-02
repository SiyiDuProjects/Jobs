export {};

const $ = (id) => document.getElementById(id);
const select = (id) => /** @type {HTMLSelectElement} */ ($(id));
let current;
const status = {
  validation_error: "校验报错",
  selection_pending: "下拉尚未选定",
  value_observed: "页面有值（接受状态未知）",
  attempted_still_empty: "尝试后仍为空",
  answer_missing: "未找到答案",
  unhandled_control: "控件类型待适配",
  not_attempted: "未观察到填写尝试",
};
const answers = {
  unknown: "未观察到匹配",
  found: "找到答案",
  missing: "没有答案",
};
async function request(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...extra });
  if (result?.error) throw Error(result.error);
  return result?.data;
}
function render(row) {
  current = row;
  const report = row?.report;
  if (!report) return;
  $("overview").textContent =
    `${report.pageUrl}\nProfile：${report.profileName || "尚未读取"} · ${report.ats} · ${report.version}\n观察时间：${new Date(report.observedAt).toLocaleString()} · 阶段：${report.phase}\n控件 ${report.counts.controls} · 空白 ${report.counts.empty} · 校验错误 ${report.counts.invalid}\n复用已有控件读取器：${report.coverage.scope}，不是完整检测。其他 frame ${report.coverage.iframeCount}，可能仍有未识别控件；敏感字段不记录。${report.coverage.scanLimited ? "扫描已达上限。" : ""}${report.droppedEvents ? "较早事件已裁剪。" : ""}`;
  $("fields").replaceChildren(
    ...report.fields.map((field) => {
      const tr = document.createElement("tr");
      for (const value of [
        field.id,
        field.question + (field.required ? " *" : ""),
        field.kind,
        status[field.status] || field.status,
        answers[field.answer] || field.answer,
        `${field.attempts} / ${field.observedEvents.join(", ")}`,
      ]) {
        const td = document.createElement("td");
        td.textContent = value;
        tr.append(td);
      }
      return tr;
    }),
  );
  const unrecognized = {
    "interactive-without-field": "有可操作元素，但没有识别成字段",
    "required-title-without-field": "必填题目旁没有识别到字段",
  };
  for (const item of report.unansweredContainers) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.textContent = `未识别：${item.question}（${unrecognized[item.reason] || item.reason || "题目存在，但未检测到控件"}）`;
    if (item.structure) {
      const pre = document.createElement("pre");
      pre.textContent = item.structure;
      td.append(pre);
    }
    tr.append(td);
    $("fields").append(tr);
  }
  $("events").replaceChildren(
    ...report.events.map((event) => {
      const li = document.createElement("li");
      li.textContent = `${new Date(event.at).toLocaleTimeString()} · ${event.type}${event.fieldId ? " · " + event.fieldId : ""}${event.detail ? " · " + event.detail : ""}`;
      return li;
    }),
  );
}
async function load() {
  const state = await request("jobs:diagnostics-list");
  const selected = select("pages").value;
  select("pages").replaceChildren(
    ...state.reports
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .map((row) => {
        const option = document.createElement("option");
        option.value = row.id;
        option.textContent = `标签 ${row.tabId} / frame ${row.frameId} · ${row.profileName || "Profile 未知"} · ${row.pageUrl}`;
        return option;
      }),
  );
  if ([...select("pages").options].some((option) => option.value === selected))
    select("pages").value = selected;
  $("sync").textContent =
    state.sync.state === "synced"
      ? "服务器最近已连接；下方展示本地诊断记录。"
      : state.sync.state === "error"
        ? `本地记录已保留；${state.sync.message}`
        : "等待诊断同步。";
  if (select("pages").value)
    render(
      await request("jobs:diagnostics-get", { id: select("pages").value }),
    );
  else {
    $("message").textContent =
      "还没有记录。重新加载 local.14 扩展后，新打开或刷新申请页，让原插件开始识别页面。";
  }
}
function action(fn) {
  return async () => {
    try {
      $("message").textContent = "";
      await fn();
    } catch (error) {
      $("message").textContent = error.message;
    }
  };
}
async function loadCases() {
  const rows = await request("jobs:repro-list");
  select("cases").replaceChildren(
    ...(rows || []).map((row) => {
      const option = document.createElement("option");
      option.value = row.id;
      option.textContent = `${new Date(row.at).toLocaleString()} · ${row.origin} · ${row.fields} 个字段 · ${row.build} · ${row.resolved ? "已解决" : "未解决"}`;
      return option;
    }),
  );
  /** @type {HTMLButtonElement} */ ($("export-case")).disabled = !(rows || [])
    .length;
}
for (const [id, resolved] of [
  ["resolve-case", true],
  ["reopen-case", false],
])
  $(id).onclick = action(async () => {
    if (!select("cases").value) return;
    await request("jobs:repro-resolve", {
      id: select("cases").value,
      resolved,
    });
    await loadCases();
  });
function download(value, name) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("capture-case").onclick = action(async () => {
  if (!select("pages").value) throw Error("请先选择仍打开的申请页面");
  const result = await request("jobs:diagnostics-capture-case", {
    id: select("pages").value,
  });
  await loadCases();
  $("case-message").textContent = result?.captured
    ? `已保存 ${result.fields} 个字段${result.truncated ? "（结构已达到上限）" : ""}。`
    : "当前没有可记录的未完成字段。";
});
$("export-case").onclick = action(async () => {
  const value = await request("jobs:repro-get", { id: select("cases").value });
  if (!value) throw Error("案例已被更新，请刷新列表");
  download(value, `jobs-repro-${value.capturedAt}.json`);
  $("case-message").textContent =
    "已导出。案例可生成离线控件回归测试；不代表完整网站行为已重现。";
});
$("reload").addEventListener("click", action(loadCases));
$("reload").onclick = action(load);
select("pages").onchange = action(async () =>
  render(await request("jobs:diagnostics-get", { id: select("pages").value })),
);
$("inspect").onclick = action(async () => {
  if (!select("pages").value) return;
  render(
    await request("jobs:diagnostics-refresh", { id: select("pages").value }),
  );
  $("message").textContent = "已读取，未填写或点击申请页面。";
});
$("export").onclick = () => {
  if (!current) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(current, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download =
    "jobs-diagnostics-" +
    new Date().toISOString().replace(/[:.]/g, "-") +
    ".json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
await action(load)();
await action(loadCases)();
