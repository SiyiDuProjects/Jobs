import { mountDiagnosticsView } from "./diagnostics-view.jsx";
import { historyEventMetrics } from "./history-event-metrics.js";

mountDiagnosticsView();
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
// The run's own ledger outcome: who decided the field and why it was left.
const deciders = {
  binding: "平台适配",
  rule: "本地规则",
  saved: "保存答案",
  ai: "AI",
  remote: "远程命令",
  user: "你",
  agent: "AI 操作者",
  "page-tool": "页面工具",
  unknown: "未知操作者",
  other: "其他",
};
const outcomeStates = {
  open: "未处理",
  claimed: "写入中",
  decided: "已定",
  abstained: "未写成",
  omitted: "未作答",
  unrecognized: "未识别",
};
const outcomeReasons = {
  unrecognized: "题目未识别",
  unsupported_control: "控件类型待适配",
  missing_fact: "资料缺少所需事实",
  answer_unknown: "AI 不知道答案",
  answer_missing: "AI 没有返回答案",
  answer_invalid: "AI 答案不可用",
  unrecognized_question: "题目未被理解",
  ai_unavailable: "AI 暂不可用",
  ai_rate_limited: "AI 额度暂用完",
  draft_unavailable: "草稿未生成",
  saved_answer_changed: "保存的答案已变化",
  optional_skipped: "选填题跳过",
  readiness_timeout: "表单就绪超时",
  control_failure: "写入或回读失败",
  not_committed: "控件没有接受",
  value_lost: "写入后值丢失",
  page_unconfirmed: "页面更新未确认",
  field_changed: "写入前控件已变化",
  out_of_scope: "不在当前表单",
  taken: "已由操作者接手",
  context_changed: "上下文已变化",
  write_error: "写入出错",
  other: "其他原因",
};
const outcomeText = (outcome = { state: "open" }) =>
  (outcome.by ? deciders[outcome.by] || outcome.by : "") +
  (outcomeStates[outcome.state] || outcome.state) +
  (outcome.taken ? "（网页上直接改）" : "") +
  (outcome.from ? "，替换" + (deciders[outcome.from] || outcome.from) : "") +
  (outcome.reason
    ? "：" + (outcomeReasons[outcome.reason] || outcome.reason)
    : "") +
  (outcome.review ? " · 在审核卡" : "");
async function request(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...extra });
  if (result?.error) throw Error(result.error);
  return result?.data;
}
function render(row) {
  current = row;
  const report = row?.report;
  if (!report) return;
  $("message").textContent = row.historyUnavailable
    ? "已读取当前控件；历史记录保存或读取失败，时间线可能不完整。原有记录保留。"
    : "";
  $("overview").textContent =
    `${report.pageUrl}\n资料：${report.profileName || "尚未读取"} · ${report.ats} · ${report.version}\n观察时间：${new Date(report.observedAt).toLocaleString()} · 阶段：${report.phase}\n控件 ${report.counts.controls} · 空白 ${report.counts.empty} · 校验错误 ${report.counts.invalid}\n复用已有控件读取器：${report.coverage.scope}，不是完整检测。其他 frame ${report.coverage.iframeCount}，可能仍有未识别控件；敏感字段不记录。${report.coverage.scanLimited ? "扫描已达上限。" : ""}${report.droppedEvents ? "较早事件已裁剪。" : ""}`;
  $("fields").replaceChildren(
    ...report.fields.map((field) => {
      const tr = document.createElement("tr");
      tr.className = "table__row";
      for (const value of [
        field.id,
        field.question + (field.required ? " *" : ""),
        field.kind,
        status[field.status] || field.status,
        outcomeText(field.outcome),
        answers[field.answer] || field.answer,
        `${field.attempts} / ${field.observedEvents.join(", ")}`,
      ]) {
        const td = document.createElement("td");
        td.className = "table__cell";
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
    td.colSpan = 7;
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
      const usage =
        event.answerUsage ||
        historyEventMetrics(event.type, event.detail).answerUsage;
      const detail = usage
        ? usage.unavailable
          ? "回答批次计数不可用"
          : `缓存命中 ${usage.cacheHits} 题 / 送模型 ${usage.modelFields} 题 / 模型请求 ${usage.modelCalls} 次（含核验）`
        : event.detail ||
          event.phase ||
          (event.field
            ? JSON.stringify({
                question: event.field.question,
                decision: event.field.decision,
                trace: event.field.trace,
                status: event.field.status,
              })
            : event.trace
              ? JSON.stringify(event.trace)
              : "");
      li.textContent = `${new Date(event.at).toLocaleTimeString()} · ${event.sequence ? "#" + event.sequence + " · " : ""}${event.type}${event.fieldId ? " · " + event.fieldId : ""}${detail ? " · " + detail : ""}${event.evidence ? " · " + JSON.stringify(event.evidence) : ""}`;
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
        option.textContent = `标签 ${row.tabId} / frame ${row.frameId} · ${row.profileName || "资料未知"} · ${row.pageUrl}`;
        return option;
      }),
  );
  if ([...select("pages").options].some((option) => option.value === selected))
    select("pages").value = selected;
  const sync = state.sync;
  const failure = sync.lastFailure;
  const failureLabels = {
    packet_too_large: "记录超过上传大小限制",
    invalid_list: "记录列表不符合服务限制",
    invalid_shape: "记录格式不符合服务要求",
    invalid_text: "记录文本不符合服务要求",
    invalid_integer: "记录数值不符合服务要求",
    invalid_boolean: "记录状态不符合服务要求",
    credential_data: "服务检测到不应上传的数据",
    invalid_url: "记录地址不符合服务要求",
    not_acknowledged: "服务未确认接收",
    timeout: "上传超时",
    upload_failed: "上传连接或本地处理失败",
    http_error: "服务拒收",
  };
  const labels = {
    local: "仅本地记录",
    disconnected: "诊断同步未连接",
    uploading: "诊断上传中",
    synced: "最近一批诊断已确认接收",
    error: "诊断上传失败，本地记录保留",
    rejected: "部分诊断被拒收，本地记录保留",
    upgrade_required: "服务需升级才能接收完整证据，本地记录保留",
  };
  $("sync").textContent =
    `${labels[sync.state] || "诊断状态未知"} · 待上传 ${sync.pending ?? "未知"} 条运行` +
    (sync.lastAckAt
      ? ` · 最近确认 ${new Date(sync.lastAckAt).toLocaleString()}`
      : " · 尚无上传确认") +
    (sync.newestLocalAt
      ? ` · 本地最新 ${new Date(sync.newestLocalAt).toLocaleString()}`
      : "") +
    (failure
      ? ` · 最近失败：${failureLabels[failure.reason] || "原因未分类"}${failure.httpStatus ? `（HTTP ${failure.httpStatus}）` : ""}`
      : "");
  if (select("pages").value)
    render(
      await request("jobs:diagnostics-get", { id: select("pages").value }),
    );
  else {
    $("message").textContent =
      "还没有事件记录。下一次正常打开申请页时会开始记录；无需刷新正在填写的页面。";
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
  const rows = await request("jobs:corpus-failures");
  select("cases").replaceChildren(
    ...(rows || []).map((row) => {
      const option = document.createElement("option");
      option.value = row.id;
      option.textContent = `${new Date(row.at).toLocaleString()} · ${row.reason} · ${row.fieldIds.length} 道标记题目 · ${row.pageId.slice(0, 12)} · ${row.resolved ? "已解决" : "未解决"}`;
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
    await request("jobs:corpus-resolve-failure", {
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
  if (!select("pages").value) throw Error("请先选择仍打开的投递页面");
  const result = await request("jobs:diagnostics-capture-case", {
    id: select("pages").value,
  });
  await loadCases();
  $("case-message").textContent = result?.captured
    ? `已保存 ${result.fields} 个字段${result.truncated ? "（结构已达到上限）" : ""}。`
    : "当前没有可采集的题库页面，或题库尚未确认接收。";
});
$("export-case").onclick = action(async () => {
  const value = await request("jobs:corpus-failure-page", {
    id: select("cases").value,
  });
  if (!value) throw Error("案例已被更新，请刷新列表");
  download(value, `jobs-corpus-${value.id}.json`);
  $("case-message").textContent =
    "已导出失败题库页面，可用于离线回放；不代表真实网站已验收。";
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
  if (!current?.historyUnavailable)
    $("message").textContent = "已读取，未填写或点击投递页面。";
});
$("export").onclick = action(async () => {
  if (!current) return;
  const data = await request("jobs:diagnostics-export", { id: current.id });
  download(
    data,
    "jobs-diagnostics-" +
      new Date().toISOString().replace(/[:.]/g, "-") +
      ".json",
  );
  $("message").textContent = "已导出持久证据；答案和选项已替换为虚构标记。";
});
await action(load)();
await action(loadCases)();
