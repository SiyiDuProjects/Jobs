import { useMemo, useState } from "react";
import { applicationFlow } from "./application-flow";
import type { Application } from "./model";

export function ApplicationFlow({
  rows,
  onSelect,
}: {
  rows: Application[];
  onSelect: (label: string, ids: string[] | null) => void;
}) {
  const graph = useMemo(() => applicationFlow(rows), [rows]);
  const [hover, setHover] = useState<string | null>(null);
  if (!rows.length)
    return (
      <div className="flex min-h-64 items-center justify-center text-muted">
        暂无匹配的投递记录
      </div>
    );
  return (
    <div className="application-flow">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${graph.width} ${graph.height}`}
          className="application-flow-svg"
          style={{ minWidth: graph.width, height: graph.height }}
          aria-label={`申请流向图，共 ${rows.length} 条记录`}
        >
          <desc>
            从已投递流向已记录的
            OA、面试和结果。线宽按申请数量绘制，点击节点可查看对应申请。
          </desc>
          {graph.links.map(({ source, target, path }) => (
            <path
              key={target.id}
              d={path}
              fill={target.color}
              stroke={target.color}
              strokeWidth={target.height < 1 ? 1 : 0}
              opacity={
                !hover ||
                target.id === hover ||
                source.id === hover ||
                hover.startsWith(target.id + "/")
                  ? 0.32
                  : 0.06
              }
              style={{ transition: "opacity 120ms" }}
            >
              <title>
                {source.label} → {target.label}：{target.count}
              </title>
            </path>
          ))}
          {graph.nodes.map((n) => (
            <g
              key={n.id}
              role="button"
              tabIndex={0}
              className="application-flow-node"
              aria-label={`${n.label}：${n.count} 条申请，点击查看`}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(n.id)}
              onBlur={() => setHover(null)}
              onClick={() => onSelect(n.label, n.parent ? n.ids : null)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(n.label, n.parent ? n.ids : null);
                }
              }}
            >
              <rect
                x={n.x - 6}
                y={n.y + Math.max(1, n.height) / 2 - 22}
                width={174}
                height={44}
                fill="transparent"
                rx={5}
              />
              <rect
                x={n.x}
                y={n.y}
                width={12}
                height={Math.max(1, n.height)}
                fill={n.color}
                rx={2}
              />
              <text
                x={n.x + 22}
                y={n.y + n.height / 2 - 3}
                className="application-flow-label"
              >
                {n.label}
              </text>
              <text
                x={n.x + 22}
                y={n.y + n.height / 2 + 16}
                className="application-flow-count"
              >
                {n.count.toLocaleString()}
              </text>
              <title>
                {n.label}：{n.count} 条
                {n.parent
                  ? `（${((n.count / rows.length) * 100).toFixed(1)}%）`
                  : ""}
              </title>
            </g>
          ))}
        </svg>
      </div>
      <p className="text-xs text-muted">
        按已记录的路径绘制 · 点击节点查看申请 · 自动或待确认的 OA 不计入有效推进
      </p>
    </div>
  );
}
