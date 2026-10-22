import type { Application } from "./model";
const day = 86400000;
export function applicationInsights(rows: Application[], now = Date.now()) {
  const waiting = [0, 0, 0, 0];
  const sources = new Map<
    string,
    { source: string; count: number; advanced: number; waiting: number }
  >();
  let advanced = 0,
    dated = 0,
    unknownDates = 0;
  let earliest = Infinity,
    latest = -Infinity;
  for (const row of rows) {
    const p = row.progress;
    // Use the server's evidence-based advancement contract, never infer an
    // automatic assessment or an unrecorded reply as screening or rejection.
    const progressed =
      p?.ever_advanced === true ||
      (p?.highest_stage != null &&
        ["assessment", "interview", "offer"].includes(p.highest_stage));
    if (progressed) advanced++;
    const stage = p?.stage || row.status;
    const awaiting =
      !progressed &&
      ["applied", "received", "submitted", "no_answer"].includes(stage);
    const applied = +new Date(row.date);
    if (Number.isFinite(applied) && applied <= now) {
      dated++;
      earliest = Math.min(earliest, applied);
      latest = Math.max(latest, applied);
      if (awaiting) {
        const age = Math.floor((now - applied) / day);
        waiting[age < 7 ? 0 : age < 14 ? 1 : age < 30 ? 2 : 3]++;
      }
    } else unknownDates++;
    // Each record counts once. Multi-source discoveries retain their source
    // combination rather than being double-counted in each source's rate.
    const source =
      [...new Set((row.job?.sources || []).filter(Boolean))]
        .sort()
        .join(" + ") || "来源未记录";
    const entry = sources.get(source) || {
      source,
      count: 0,
      advanced: 0,
      waiting: 0,
    };
    entry.count++;
    entry.advanced += Number(progressed);
    entry.waiting += Number(awaiting);
    sources.set(source, entry);
  }
  return {
    count: rows.length,
    advanced,
    waiting,
    dated,
    unknownDates,
    earliest,
    latest,
    sources: [...sources.values()].sort(
      (a, b) => b.count - a.count || a.source.localeCompare(b.source),
    ),
  };
}
