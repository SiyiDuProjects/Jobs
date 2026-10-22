// User-requested option discovery shares the review's serialized action queue.
// It never resolves an answer, confirms the review, or navigates the page.
export async function loadReviewOptions(own, id, payload, isCurrent) {
  const rows = isCurrent() ? own.refresh(false, false) : [];
  const entry = [...own.items].find(([, item]) => item.id === id);
  if (!entry || own.busy || (own.confirming && !own.draining) || !own.onConfirm)
    return { error: "当前不能加载选项，请稍候。" };
  const [node, item] = entry;
  const row = rows.find((row) => row.node === node);
  const current = () =>
    isCurrent() &&
    own.root.isConnected &&
    node.isConnected &&
    location.href === own.url;
  if (
    !current() ||
    !row ||
    payload?.version !== item.version ||
    own.signature(row) !== item.signature
  )
    return { error: "题目已变化，请使用当前题目重新加载选项。" };
  if (
    typeof payload?.query !== "string" ||
    payload.query.length > 500 ||
    !own.reader.readOptions
  )
    return { error: "请输入不超过 500 字的搜索词。" };
  own.busy = true;
  item.error = "";
  own.refresh();
  try {
    await own.validate?.();
    if (!current()) throw Error("页面已变化，请重新加载选项。");
    const options = await own.reader.readOptions(row, current, {
      answer: payload.query,
      browse: true,
    });
    await own.validate?.();
    if (!current()) throw Error("页面已变化，请重新加载选项。");
    if (!options.length)
      throw Error("暂未找到选项，可输入更具体的关键词再加载。");
    return { ok: true };
  } catch (error) {
    item.error = /[\u4e00-\u9fff]/.test(error.message || "")
      ? error.message
      : "选项加载失败，请重试。";
    return { error: item.error };
  } finally {
    own.busy = false;
    if (isCurrent()) own.refresh();
  }
}
