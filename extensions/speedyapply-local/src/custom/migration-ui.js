import { JobsBuildInfo } from "./build-info.js";
import { JobsStorageMigrationPolicy as policy } from "./storage-migration-policy.js";
const statusNode = document.getElementById("status"),
  review = document.getElementById("review");
const buttons = Object.fromEntries(
  ["start", "resume", "apply", "cleanup", "supersede"].map((id) => [
    id,
    /** @type {HTMLButtonElement} */ (document.getElementById(id)),
  ]),
);
let currentPlan,
  busy = false,
  activePreview;
const labels = {
  not_started: "尚未开始，旧资料保持不变。",
  maintenance: "自动填写已暂停，请完成备份核对。",
  receiving: "正在准备完整备份，旧资料尚未清理。",
  backed_up: "备份与恢复核验已完成，请核对差异。",
  required_input: "有差异需要你确认；旧资料保持不变。",
  ready_to_apply: "差异已核对，可以保存到 jobs。",
  applying: "正在保存已确认的内容。",
  ready_to_clean: "服务器已保存并核验，可以清理对应旧缓存。",
  cleaning: "正在逐项核验和清理。关闭本页会暂停，可稍后继续。",
  complete: "迁移已核验完成，已清理本次范围内的旧缓存。",
  superseded: "原备份已保留，请重新核对变化后的资料。",
};
function display(result) {
  const state = result.status || result;
  statusNode.textContent = labels[state.phase] || "迁移等待核对。";
  if (state.buildChanged)
    statusNode.textContent += " 插件版本已改变，请保留原备份并重新核对来源。";
  if (state.entries)
    statusNode.textContent += ` 已核验清理 ${state.cleaned || 0} 项，来源共 ${state.entries} 项。`;
  buttons.start.hidden = state.phase !== "not_started";
  buttons.resume.hidden = ["not_started", "complete"].includes(state.phase);
  buttons.cleanup.hidden = !["ready_to_clean", "cleaning"].includes(
    state.phase,
  );
  buttons.supersede.hidden =
    ["not_started", "complete"].includes(state.phase) ||
    (state.phase === "maintenance" && !state.buildChanged);
  if (result.plan) currentPlan = result.plan;
  else if (
    !["backed_up", "required_input", "ready_to_apply"].includes(state.phase)
  )
    currentPlan = null;
  buttons.apply.hidden =
    currentPlan?.phase !== "ready_to_apply" ||
    !["ready_to_apply", "backed_up", "required_input"].includes(state.phase);
  if (result.plan || !currentPlan) renderReview(currentPlan);
}
function renderReview(plan) {
  activePreview?.();
  activePreview = undefined;
  review.replaceChildren();
  if (!plan) return;
  for (const conflict of plan.conflicts || []) {
    const row = document.createElement("article"),
      title = document.createElement("h2"),
      detail = document.createElement("p");
    title.textContent = conflict.title;
    detail.textContent = conflict.detail;
    row.append(title, detail);
    const select = document.createElement("select");
    select.setAttribute("aria-label", conflict.title);
    select.append(new Option("请选择…", ""));
    for (const choice of conflict.choices || [])
      select.append(new Option(choice.label, choice.id));
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = "确认这一项";
    confirm.disabled = true;
    const show = document.createElement("button"),
      content = document.createElement("div");
    show.type = "button";
    show.textContent = "查看差异";
    show.disabled = true;
    content.setAttribute("aria-live", "polite");
    let previewId,
      cursor,
      bytes = 0,
      count = 0,
      loading = false,
      generation = 0;
    const seen = new Set();
    const choice = () =>
      (conflict.choices || []).find((value) => value.id === select.value);
    function controls() {
      const selected = choice();
      confirm.disabled =
        busy ||
        loading ||
        !selected ||
        (selected.requiresPreview !== false && !previewId);
      show.hidden = selected?.requiresPreview === false;
      show.disabled = busy || loading || !selected || !!previewId;
    }
    const clearPreview = () => {
      generation++;
      previewId = undefined;
      cursor = undefined;
      bytes = 0;
      count = 0;
      seen.clear();
      content.replaceChildren();
      show.textContent = "查看差异";
      controls();
    };
    select.addEventListener("change", clearPreview);
    show.addEventListener("click", async () => {
      if (busy || loading || !choice()) return;
      if (activePreview !== clearPreview) {
        activePreview?.();
        activePreview = clearPreview;
      }
      loading = true;
      const requested = generation,
        choiceId = select.value;
      controls();
      select.disabled = true;
      try {
        const result = await send("preview", {
          planRevision: plan.revision,
          conflictId: conflict.id,
          choiceId,
          ...(cursor ? { cursor } : {}),
        });
        if (requested !== generation || !row.isConnected) return;
        const page = result.preview;
        bytes += new TextEncoder().encode(JSON.stringify(page)).length;
        count += page.rows.length;
        if (
          bytes > policy.limits.maxPreviewBytes ||
          count > policy.limits.maxPreviewRows ||
          (page.nextCursor && seen.has(page.nextCursor))
        )
          throw Error("差异超过安全预览范围，尚未显示完整，不能确认这一项。");
        for (const field of page.rows) {
          const item = document.createElement("section"),
            heading = document.createElement("h3"),
            before = document.createElement("pre"),
            after = document.createElement("pre");
          heading.textContent =
            field.path +
            (field.parts ? `（第 ${field.part}/${field.parts} 段）` : "");
          before.textContent =
            "jobs 当前内容\n" + JSON.stringify(field.current, null, 2);
          after.textContent =
            "旧来源内容\n" + JSON.stringify(field.source, null, 2);
          item.append(heading, before, after);
          content.append(item);
        }
        if (page.complete) {
          previewId = page.previewId;
          show.textContent = "已完整显示";
        } else if (page.nextCursor) {
          cursor = page.nextCursor;
          seen.add(cursor);
          show.textContent = "继续查看差异";
        } else {
          throw Error("差异尚未完整显示，不能确认；请先处理超出范围的内容。");
        }
      } catch (error) {
        previewId = undefined;
        show.disabled = true;
        statusNode.textContent = error.message;
      } finally {
        loading = false;
        select.disabled = false;
        controls();
      }
    });
    confirm.addEventListener(
      "click",
      () =>
        void run("resolve", {
          planRevision: plan.revision,
          conflictId: conflict.id,
          choiceId: select.value,
          ...(previewId ? { previewId } : {}),
        }),
    );
    row.append(select, show, confirm, content);
    review.append(row);
  }
}
async function send(action, input = {}) {
  const reply = await chrome.runtime.sendMessage({
    type: "jobs:storage-migration",
    build: JobsBuildInfo.id,
    action,
    input,
  });
  if (reply?.error) throw Error(reply.error);
  return reply.data;
}
async function run(action, input = {}) {
  if (busy) return;
  busy = true;
  for (const button of document.querySelectorAll("button"))
    button.disabled = true;
  try {
    let result = await send(action, input);
    display(result);
    while (action === "cleanup" && result.status?.phase !== "complete") {
      result = await send("cleanup");
      display(result);
    }
  } catch (error) {
    statusNode.textContent = error.message;
  } finally {
    busy = false;
    for (const button of Object.values(buttons)) button.disabled = false;
  }
}
buttons.start.addEventListener("click", () => void run("start"));
buttons.resume.addEventListener("click", () => void run("resume"));
buttons.apply.addEventListener(
  "click",
  () => void run("apply", { planRevision: currentPlan?.revision }),
);
buttons.cleanup.addEventListener("click", () => void run("cleanup"));
buttons.supersede.addEventListener("click", () => {
  currentPlan = null;
  void run("supersede");
});
void run("status");
