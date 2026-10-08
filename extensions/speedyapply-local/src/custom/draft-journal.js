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
    items.set(row.key, {
      key: row.key,
      question: row.question,
      answer: row.answer,
    });
  }
  if (items.size > 90) throw Error("草稿清单过长，请检查当前申请");
  const next = [...items.values()];
  if (JSON.stringify(next) === JSON.stringify(state.items)) return state;
  return { revision: state.revision + 1, approved: -1, items: next };
}
export function approveDraftJournal(state, revision) {
  if (!state || state.revision !== revision)
    throw Error("草稿已改变，请重新核对清单");
  return { ...state, approved: revision };
}
