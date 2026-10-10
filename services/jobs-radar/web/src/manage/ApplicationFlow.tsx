import { useMemo } from "react";
import { Button, Card } from "@heroui/react";
import {
  Layer,
  Rectangle,
  ResponsiveContainer,
  Sankey,
  Text,
  Tooltip,
  type SankeyNodeProps,
} from "recharts";
import { applicationFlow } from "./application-flow";
import { chineseProgress, type Application } from "./model";

function FlowNode({ x, y, width, height, payload }: SankeyNodeProps) {
  return (
    <Layer>
      <Rectangle
        x={x}
        y={y}
        width={width}
        height={height}
        fill="var(--accent)"
      />
      <Text
        x={x + width + 8}
        y={y + height / 2}
        verticalAnchor="middle"
        fill="var(--foreground)"
        fontSize={13}
      >
        {`${payload.name} · ${payload.value}`}
      </Text>
    </Layer>
  );
}
export function ApplicationFlow({
  rows,
  onSelect,
}: {
  rows: Application[];
  onSelect: (label: string, ids: string[] | null) => void;
}) {
  const graph = useMemo(() => applicationFlow(rows), [rows]);
  const data = useMemo(
    () => ({
      nodes: graph.nodes.map((n) => ({
        ...n,
        name:
          n.stage === "applications"
            ? "已投递"
            : n.stage === "no_answer"
              ? "暂无有效推进"
              : chineseProgress(n.label)
                  .replace(/面试 (\d+)/, "面试 · 第 $1 轮")
                  .replace("Rejected", "已拒绝")
                  .replace("Accepted", "已接受")
                  .replace("Withdrawn", "已撤回")
                  .replace("Archived", "已归档"),
      })),
      links: graph.links.map((l) => ({
        source: graph.nodes.indexOf(l.source),
        target: graph.nodes.indexOf(l.target),
        value: l.target.count,
      })),
    }),
    [graph],
  );
  if (!rows.length) return null;
  return (
    <Card>
      <Card.Header>
        <Card.Title>投递进展</Card.Title>
        <Card.Description>
          共 {rows.length} 条 · 按已确认的招聘路径统计，包含外部投递。
        </Card.Description>
      </Card.Header>
      <Card.Content>
        <div className="overflow-x-auto">
          <div className="min-w-3xl">
            <ResponsiveContainer
              width="100%"
              minWidth={graph.width}
              height={Math.max(320, graph.height)}
            >
              <Sankey
                data={data}
                node={FlowNode}
                nodePadding={36}
                nodeWidth={10}
                margin={{ top: 24, bottom: 24, left: 8, right: 160 }}
                link={{ stroke: "var(--accent)" }}
                title="投递进展流向"
                onClick={(item, type) => {
                  if (type === "node") {
                    const n = data.nodes[item.index];
                    onSelect(n.name, n.parent ? n.ids : null);
                  }
                }}
              >
                <Tooltip />
              </Sankey>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="flex flex-wrap gap-2" aria-label="按进展查看投递">
          {data.nodes
            .filter((n) => n.depth <= 1)
            .map((n) => (
              <Button
                key={n.id}
                size="sm"
                variant="secondary"
                onPress={() => onSelect(n.name, n.parent ? n.ids : null)}
              >
                {n.name} · {n.count}
              </Button>
            ))}
        </div>
      </Card.Content>
      <Card.Footer>
        <p className="text-xs text-muted">
          在线测评包含笔试、游戏和录播题；HR 面试单列，其他面试按轮次记录。自动发放或发放方式未确认的测评不计入有效推进，具体状态见下表。
        </p>
      </Card.Footer>
    </Card>
  );
}
