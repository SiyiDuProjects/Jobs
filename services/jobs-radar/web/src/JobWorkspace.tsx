import { type ComponentType, type ReactNode } from "react";
import { Segment } from "@heroui-pro/react";
import { AppliedView } from "./manage/AppliedView";
import { useManagement } from "./manage/store";
import { ApplicationTotals } from "./ApplicationTotals";
export type JobKind = "newgrad" | "internship";
export type BoardProps = {
  kind: JobKind;
  trash: boolean;
  navigation: ReactNode;
  query: string;
  setQuery: (value: string) => void;
};
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
  query,
  setQuery,
}: {
  Board: ComponentType<BoardProps>;
  kind: JobKind;
  route: string;
  query: string;
  setQuery: (value: string) => void;
}) {
  const { error } = useManagement();
  const view =
    route === "/applied" || route === "/applications"
      ? "applied"
      : route === "/trash"
        ? "trash"
        : "jobs";
  const navigation = <Segment
          aria-label="岗位视图"
          selectedKey={view}
          onSelectionChange={(v) => {
            location.hash = v === "jobs" ? "/" : "/" + v;
          }}
        >
          <Segment.Item id="jobs">岗位</Segment.Item>
          <Segment.Item id="applied">已投递</Segment.Item>
          <Segment.Item id="trash">已删除</Segment.Item>
        </Segment>;
  return (
    <div className="space-y-5">
      {error && (
        <p className="text-danger" role="alert">
          {error}
        </p>
      )}
      {view === "applied" ? (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            {navigation}
            <ApplicationTotals key={kind} kind={kind} />
          </div>
          <AppliedView key={kind} kind={kind} />
        </>
      ) : (
        <Board key={`${view}:${kind}`} kind={kind} trash={view === "trash"} navigation={navigation} query={query} setQuery={setQuery} />
      )}
    </div>
  );
}
