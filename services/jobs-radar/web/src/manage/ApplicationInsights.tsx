import { useMemo } from "react";
import { applicationInsights } from "./application-insights";
import { dateLabel } from "./application-format";
import type { Application } from "./model";
const percent = (part: number, all: number) =>
  all ? `${Math.round((part / all) * 100)}%` : "—";
export function ApplicationInsights({ rows }: { rows: Application[] }) {
  const data = useMemo(() => applicationInsights(rows), [rows]);
  return (
    <section aria-label="投递效果分析" className="space-y-4">
      <div>
        <h2 className="font-semibold">当前筛选的投递效果</h2>
        <p className="text-sm text-muted">
          样本 {data.count} 条
          {data.dated > 0
            ? ` · 投递时间 ${dateLabel(new Date(data.earliest).toISOString())}–${dateLabel(new Date(data.latest).toISOString())}`
            : ""}{" "}
          · 截至 {dateLabel(new Date().toISOString())}
        </p>
      </div>
      <p>
        已记录有效推进 {data.advanced} / {data.count}（
        {percent(data.advanced, data.count)}）
      </p>
      <div>
        <h3 className="text-sm font-medium mb-2">尚无进展记录的等待时长</h3>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          {["不足 7 天", "7–13 天", "14–29 天", "30 天以上"].map(
            (label, index) => (
              <div key={label} className="rounded-lg bg-surface-secondary p-3">
                <dt className="text-muted">{label}</dt>
                <dd className="tabular-nums mt-1">{data.waiting[index]} 条</dd>
              </div>
            ),
          )}
        </dl>
        {data.unknownDates > 0 && (
          <p className="text-sm text-muted mt-2">
            {data.unknownDates} 条日期缺失或在未来，未计入等待时长。
          </p>
        )}
      </div>
      <div className="overflow-x-auto">
        <table
          className="w-full text-sm text-left"
          aria-label="按来源比较有效推进"
        >
          <thead>
            <tr className="border-b border-separator">
              <th className="py-2">岗位来源</th>
              <th>样本</th>
              <th>有效推进</th>
              <th>尚无进展记录</th>
            </tr>
          </thead>
          <tbody>
            {data.sources.map((row) => (
              <tr key={row.source} className="border-b border-separator">
                <td className="py-2">{row.source}</td>
                <td className="tabular-nums">{row.count}</td>
                <td className="tabular-nums">
                  {row.advanced}（{percent(row.advanced, row.count)}）
                </td>
                <td className="tabular-nums">{row.waiting}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-muted">
        推进按已有记录统计，自动发放的测评不等于通过筛选。未记录回复不代表被拒；较新的申请观察时间更短。先用投递日期选择同一批次，再比较来源。多来源岗位按来源组合计一次。
      </p>
    </section>
  );
}
