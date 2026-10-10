import { sameValue } from "./stable-value.js";
// A per-application, session-only checklist. Approval belongs to one revision.
export function updateDraftJournal(current, changes) {
  const state = current || { revision: 0, approved: -1, items: [] };
  const items = new Map(state.items.map((item) => [item.key, item]));
  for (const row of changes) {
    if (
      !row ||
      typeof row.key !== "string" ||
      row.key.length > 20000 ||
      typeof row.question !== "string" ||
      row.question.length > 2000 ||
      typeof row.answer !== "string" ||
      row.answer.length > 4000
    )
      throw Error("Invalid draft checklist");
    const translations = {};
    for (const name of ["questionZh", "answerZh", "reasonZh"]) {
      if (row[name] === undefined) continue;
      if (typeof row[name] !== "string" || row[name].length > 1000)
        throw Error("Invalid draft translation");
      translations[name] = row[name];
    }
    items.set(row.key, {
      key: row.key,
      question: row.question,
      answer: row.answer,
      ...translations,
    });
  }
  if (items.size > 90) throw Error("草稿清单过长，请检查当前申请");
  const next = [...items.values()];
  // Chrome storage can return object properties in a different order. Only
  // answer content/identity changes invalidate the revision a person reviewed.
  if (
    next.length === state.items.length &&
    next.every((item, index) => {
      const before = state.items[index];
      return sameValue(item, before);
    })
  )
    return state;
  return { revision: state.revision + 1, approved: -1, items: next };
}
export function approveDraftJournal(state, revision) {
  if (!state || state.revision !== revision)
    throw Error("草稿已改变，请重新核对清单");
  return { ...state, approved: revision };
}
