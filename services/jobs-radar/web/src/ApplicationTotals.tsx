import { useEffect, useState } from "react";
import { api } from "./job-board-model";

export function ApplicationTotals({ kind }: { kind: 'newgrad' | 'internship' }) {
  const [counts, setCounts] = useState<{ today: number; week: number }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let controller: AbortController | undefined;
    const refresh = () => {
      if (document.hidden) return;
      controller?.abort();
      const request = (controller = new AbortController());
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const week = new Date(today);
      week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
      void api(`/api/application-counts?kind=${kind}&today=${+today / 1000}&week=${+week / 1000}`, { signal: request.signal })
        .then(value => { if (!request.signal.aborted) { setCounts(value); setFailed(false); } })
        .catch(() => { if (!request.signal.aborted) setFailed(true); });
    };
    refresh();
    const timer = setInterval(refresh, 60000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("jobs:applications-changed", refresh);
    return () => {
      controller?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("jobs:applications-changed", refresh);
    };
  }, [kind]);
  return <span className="application-totals text-muted" aria-live="polite">
    {failed ? "投递数暂时不可用" : counts ? `今日 ${counts.today} · 本周 ${counts.week}` : "今日 — · 本周 —"}
  </span>;
}
