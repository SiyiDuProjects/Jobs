import { type ComponentType } from "react";
import { Segment } from "@heroui-pro/react";
import {
  AppliedView,
  PendingMail,
  applicationCounts,
} from "./manage/AppliedView";
import { useManagement } from "./manage/store";
export type JobKind = "newgrad" | "internship";
export type BoardProps = { kind: JobKind; trash: boolean };
export function readKind(): JobKind {
  const value =
    new URLSearchParams(location.search).get("kind") ||
    localStorage.getItem("radar-kind");
  return value === "internship" || location.pathname === "/internships"
    ? "internship"
    : "newgrad";
}
export function JobWorkspace({
  Board,
  kind,
  route,
}: {
  Board: ComponentType<BoardProps>;
  kind: JobKind;
  route: string;
}) {
  const { docs, loading, error } = useManagement();
  const view =
    route === "/applied" || route === "/applications"
      ? "applied"
      : route === "/trash"
        ? "trash"
        : "jobs";
  const counts = applicationCounts(docs.appliedList?.value || []);
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Segment
          aria-label="岗位视图"
          selectedKey={view}
          onSelectionChange={(v) => {
            location.hash = v === "jobs" ? "/" : "/" + v;
          }}
        >
          <Segment.Item id="jobs">岗位</Segment.Item>
          <Segment.Item id="applied">已投递</Segment.Item>
          <Segment.Item id="trash">已删除</Segment.Item>
        </Segment>
        <span className="text-sm text-muted">
          {loading
            ? "正在读取投递数…"
            : `今日已投 ${counts.today} · 本周已投 ${counts.week}`}
        </span>
      </div>
      <PendingMail />
      {error && (
        <p className="text-danger" role="alert">
          {error}
        </p>
      )}
      {view === "applied" ? (
        <AppliedView />
      ) : (
        <Board key={view} kind={kind} trash={view === "trash"} />
      )}
    </div>
  );
}
