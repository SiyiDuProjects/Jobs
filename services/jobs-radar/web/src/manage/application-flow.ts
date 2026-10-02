import { type Application } from "./model";
import stageContract from "../../../jobs_radar/application-stages.json";

export type FlowNode = {
  id: string;
  stage: string;
  label: string;
  count: number;
  ids: string[];
  parent: string | null;
  depth: number;
  color: string;
  x: number;
  y: number;
  height: number;
};
const colors: Record<string, string> = {
  applications: "#1c9e97",
  no_answer: "#9ca7b3",
  assessment: "#498acc",
  interview: "#8871cb",
  phone_screen: "#4b9c91",
  offer: "#489975",
  accepted: "#489975",
  rejected: "#cb7a82",
  withdrawn: "#b29a71",
  offer_declined: "#b29a71",
  archived: "#9ca7b3",
};
const labels: Record<string, string> = stageContract.flowLabels;
const order = [
  "no_answer",
  "assessment",
  "interview",
  "phone_screen",
  "offer",
  "accepted",
  "rejected",
  "withdrawn",
  "offer_declined",
  "archived",
];

export function applicationFlow(rows: Application[]) {
  const nodes = new Map<string, FlowNode>();
  const add = (
    id: string,
    stage: string,
    label: string,
    parent: string | null,
    depth: number,
    aid: string,
  ) => {
    if (!nodes.has(id))
      nodes.set(id, {
        id,
        stage,
        label,
        parent,
        depth,
        count: 0,
        ids: [],
        color: colors[stage] || colors.archived,
        x: 0,
        y: 0,
        height: 0,
      });
    const node = nodes.get(id)!;
    node.count++;
    node.ids.push(aid);
  };
  rows.forEach((row, index) => {
    const aid = row.id || `row:${index}`;
    add("applications", "applications", "Applications", null, 0, aid);
    let parent = "applications";
    const p = row.progress;
    const steps = p?.chart_path?.length
      ? p.chart_path
      : [{ stage: "no_answer" }];
    steps.forEach((step, index) => {
      const stage = step.stage === "applied" ? "no_answer" : step.stage;
      const label =
        stage === "interview"
          ? step.final
            ? "Final Interview"
            : step.round
              ? `Interview ${step.round}`
              : "Interview"
          : labels[stage] || stage;
      const key =
        stage === "interview"
          ? `${stage}:${step.round || "?"}:${!!step.final}`
          : stage;
      const id = parent + "/" + key;
      add(id, stage, label, parent, index + 1, aid);
      parent = id;
    });
  });
  const maxDepth = Math.max(1, ...[...nodes.values()].map((n) => n.depth));
  const columns = Array.from({ length: maxDepth + 1 }, (_, depth) =>
    [...nodes.values()].filter((n) => n.depth === depth),
  );
  const sortChildren = (parent: string): FlowNode[] =>
    [...nodes.values()]
      .filter((n) => n.parent === parent)
      .sort(
        (a, b) =>
          order.indexOf(a.stage) - order.indexOf(b.stage) ||
          a.label.localeCompare(b.label, undefined, { numeric: true }),
      );
  const rank = new Map<string, number>();
  let sequence = 0;
  const walk = (id: string) => {
    rank.set(id, sequence++);
    sortChildren(id).forEach((n) => walk(n.id));
  };
  walk("applications");
  columns.forEach((col) =>
    col.sort((a, b) => (rank.get(a.id) || 0) - (rank.get(b.id) || 0)),
  );
  const gap = 42,
    height = Math.max(330, Math.max(...columns.map((c) => c.length)) * 50 + 80);
  const scale = rows.length
    ? Math.min(
        ...columns
          .filter((c) => c.length)
          .map(
            (c) =>
              (height - 40 - (c.length - 1) * gap) /
              c.reduce((v, n) => v + n.count, 0),
          ),
      )
    : 1;
  const width = Math.max(700, maxDepth * 290 + 210);
  for (const col of columns) {
    const total =
      col.reduce((v, n) => v + n.count * scale, 0) +
      Math.max(0, col.length - 1) * gap;
    let next = (height - total) / 2;
    for (const n of col) {
      n.x = 24 + n.depth * 290;
      n.height = n.count * scale;
      const parent = n.parent ? nodes.get(n.parent) : undefined;
      n.y =
        n.depth < 2
          ? next
          : Math.max(
              next,
              parent ? parent.y + parent.height / 2 - n.height / 2 : next,
            );
      next = n.y + n.height + gap;
    }
    // Keep labels within the drawing when deeper branches follow a low parent.
    const bottom = col.at(-1);
    const shift = bottom
      ? Math.max(0, bottom.y + Math.max(24, bottom.height) - height)
      : 0;
    if (shift)
      col.forEach((n) => {
        n.y -= shift;
      });
  }
  const links = [...nodes.values()]
    .filter((n) => n.parent)
    .map((target) => {
      const source = nodes.get(target.parent!)!;
      const siblings = sortChildren(source.id);
      const offset = siblings
        .slice(0, siblings.indexOf(target))
        .reduce((v, n) => v + n.height, 0);
      const x1 = source.x + 12,
        x2 = target.x,
        y1 = source.y + offset,
        y2 = target.y,
        dy = target.height,
        m = (x1 + x2) / 2;
      return {
        source,
        target,
        path: `M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2} L${x2},${y2 + dy} C${m},${y2 + dy} ${m},${y1 + dy} ${x1},${y1 + dy} Z`,
      };
    });
  return { nodes: [...nodes.values()], links, width, height: height + 20 };
}
