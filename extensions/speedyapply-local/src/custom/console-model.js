// Ordering and progress for the answer console. Pure functions over the
// worker's tab snapshot; the page documents stay the only source of answers.
const busy = new Set([
  "preparing",
  "in-progress",
  "ai-thinking",
  "ai-filling",
  "checking",
  "awaiting-transition",
]);
const done = new Set(["submitting", "confirmed", "already-applied"]);
const ready = new Set(["page-complete", "autofill-complete", "ready-submit"]);
const attention = new Set([
  "complete-required",
  "complete-manually",
  "profile-unavailable",
  "site-error",
  "ai-review",
  "message",
]);
const rank = { review: 0, attention: 1, ready: 2, busy: 3, idle: 4, done: 5 };

/** @returns {"review"|"attention"|"ready"|"busy"|"idle"|"done"} */
export function pageGroup(row) {
  if (row.review?.data || row.reviewPending) return "review";
  const phase = row.status?.phase || "";
  if (done.has(phase)) return "done";
  if (busy.has(phase)) return "busy";
  if (ready.has(phase)) return "ready";
  if (attention.has(phase) || phase.startsWith("stopped-")) return "attention";
  return "idle";
}

export const groupLabels = {
  review: "待你作答",
  attention: "需要到网页处理",
  ready: "已填好",
  busy: "正在填写",
  idle: "等待表单",
  done: "提交记录",
};

export function orderPages(rows) {
  return [...rows].sort(
    (a, b) =>
      rank[pageGroup(a)] - rank[pageGroup(b)] ||
      a.windowId - b.windowId ||
      a.index - b.index,
  );
}

export const reviewItems = (row) => row?.review?.data?.items || [];
// A pending row the person can act on here: it has an editor, or it is a
// draft summary that only needs reading before confirmation.
export const pendingItems = (row) =>
  reviewItems(row).filter((item) => item.reviewState === "pending");
export const answerable = (item) => !!item?.editor && !item.editor.disabled;

// The next question to show after `currentId`: the first pending editable
// item after it, wrapping once; null when every question is settled.
export function nextQuestion(row, currentId) {
  const items = pendingItems(row);
  const at = items.findIndex((item) => item.id === currentId);
  if (at < 0) return items[0] || null;
  return [...items.slice(at + 1), ...items.slice(0, at)][0] || null;
}

export function consoleSummary(rows) {
  const counts = {
    pages: 0,
    questions: 0,
    attention: 0,
    done: 0,
    busy: 0,
    total: rows.length,
  };
  for (const row of rows) {
    const group = pageGroup(row);
    if (group === "review") {
      counts.pages++;
      counts.questions += pendingItems(row).length;
    } else if (group === "attention") counts.attention++;
    else if (group === "done") counts.done++;
    else if (group === "busy") counts.busy++;
  }
  return counts;
}

// Keys 1-9 then 0 choose the first ten visible options.
export const optionKey = (index) =>
  index < 9 ? String(index + 1) : index === 9 ? "0" : "";
export const keyIndex = (key) =>
  /^[1-9]$/.test(key) ? Number(key) - 1 : key === "0" ? 9 : -1;

export function pageHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
export const pageTitle = (row) =>
  row.jobTitle || row.title || pageHost(row.url) || "投递页面";

// Filter long option lists by every typed word, case-insensitively.
export function filterOptions(options, query) {
  const words = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return options;
  return options.filter((option) => {
    const label = String(option.label).toLowerCase();
    return words.every((word) => label.includes(word));
  });
}

// After a refresh keep the person on the same page when it still needs
// them; otherwise move to the first page that does.
export function choosePage(rows, selected) {
  const ordered = orderPages(rows);
  const current = ordered.find((row) => row.tabId === selected);
  if (current && ["review", "attention"].includes(pageGroup(current)))
    return current.tabId;
  const next = ordered.find((row) => pageGroup(row) === "review");
  return next?.tabId ?? current?.tabId ?? ordered[0]?.tabId ?? null;
}
