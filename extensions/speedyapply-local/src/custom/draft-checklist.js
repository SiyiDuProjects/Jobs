import { stableStringify } from "./stable-value.js";
import { evidenceField } from "./answer-proof.js";
async function request(action, data = {}) {
  const result = await chrome.runtime.sendMessage({
    type: "jobs:drafts",
    action,
    ...data,
  });
  if (result?.error || !result?.data)
    throw Error(result?.error || "草稿清单未保存，请重试");
  return result.data;
}
export function createDraftChecklist(root, reader, send = request) {
  const tracked = new Map();
  const doc = root.ownerDocument || root;
  const step = stableStringify([
    doc.location?.pathname || "",
    doc.location?.hash || "",
    root.getAttribute?.("data-automation-id") || root.id || "",
    doc.querySelector('[aria-current="step"]')?.textContent?.trim() || "",
  ]);
  let pending = Promise.resolve();
  const capture = () => {
    const rows = reader.scan();
    const items = [];
    for (const [key, item] of tracked) {
      const field = JSON.parse(key);
      if (field.step !== step) continue;
      const row =
        rows.find((row) => row.node === item.node) ||
        rows.find(
          (row) =>
            row.public.id === field.fieldId &&
            row.public.question === field.question &&
            row.public.type === field.type,
        );
      if (row) item.node = row.node;
      const current = row && reader.response(row);
      if (row)
        items.push({
          key,
          question: item.question,
          answer: current?.response || "",
          ...(item.questionZh ? { questionZh: item.questionZh } : {}),
          ...(item.answerZh || item.reasonZh
            ? current?.response === item.answer
              ? { answerZh: item.answerZh || "", reasonZh: item.reasonZh || "" }
              : { answerZh: "", reasonZh: "已手动修改，请核对当前文字" }
            : {}),
        });
    }
    if (items.length)
      pending = pending.catch(() => {}).then(() => send("put", { items }));
    return pending;
  };
  const changed = (event) => {
    if (
      [...tracked.values()].some(
        (item) =>
          item.node === event.target || item.node?.contains(event.target),
      )
    )
      void capture().catch(() => {});
  };
  root.addEventListener("input", changed, true);
  root.addEventListener("change", changed, true);
  return {
    async add(field, row, answer = {}) {
      const key = stableStringify({ ...evidenceField(field), step });
      tracked.set(key, {
        node: row.node,
        question: field.question,
        answer: reader.response(row)?.response,
        questionZh: answer.questionZh,
        answerZh: answer.answerZh,
        reasonZh: answer.reasonZh,
      });
      await capture();
    },
    async read() {
      const state = await send("read");
      for (const item of state.items) {
        if (!tracked.has(item.key))
          tracked.set(item.key, { ...item, node: null });
      }
      await capture();
      return send("read");
    },
    async approve(revision) {
      await capture();
      return send("approve", { revision });
    },
    dispose() {
      root.removeEventListener("input", changed, true);
      root.removeEventListener("change", changed, true);
    },
  };
}
