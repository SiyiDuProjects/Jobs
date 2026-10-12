import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { Segment } from "@heroui-pro/react";
import { AppliedView } from "./manage/AppliedView";
import { useManagement } from "./manage/store";
import { ApplicationTotals } from "./ApplicationTotals";
import { api } from "./job-board-model";
export type JobKind = "newgrad" | "internship";
export type BoardProps = {
  kind: JobKind;
  trash: boolean;
  navigation: ReactNode;
  query: string;
  setQuery: (value: string) => void;
  onTotal?: (value: number) => void;
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
  const activeView = useRef(view);
  activeView.current = view;
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      if (document.hidden) return;
      for (const view of ["jobs", "trash"]) {
        if (activeView.current === view) continue;
        void api(
          `/api/jobs?kind=${kind}&view=${view}&status=${view === "jobs" ? "unsubmitted" : ""}&page=1&page_size=1`,
          { signal: controller.signal },
        )
          .then((data) =>
            setCounts((current) => ({ ...current, [kind + view]: data.total })),
          )
          .catch(() => {});
      }
      void api("/api/application-overview", { signal: controller.signal })
        .then((data) => {
          const values = data.highest_stage_counts?.[kind];
          if (values)
            setCounts((current) => ({
              ...current,
              [kind + "applied"]: Object.values(values).reduce<number>(
                (total, value) => total + Number(value),
                0,
              ),
            }));
        })
        .catch(() => {});
    };
    refresh();
    window.addEventListener("jobs:applications-changed", refresh);
    const timer = setInterval(refresh, 60000);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("jobs:applications-changed", refresh);
    };
  }, [kind]);
  const onTotal = useCallback(
    (total: number) =>
      setCounts((current) =>
        current[kind + view] === total
          ? current
          : { ...current, [kind + view]: total },
      ),
    [kind, view],
  );
  const navigation = (
    <Segment
      aria-label="岗位视图"
      selectedKey={view}
      onSelectionChange={(v) => {
        location.hash = v === "jobs" ? "/" : "/" + v;
      }}
    >
      {[
        ["jobs", "岗位"],
        ["applied", "已投递"],
        ["trash", "已删除"],
      ].map(([id, label]) => (
        <Segment.Item id={id} key={id} aria-label={label}>
          {label}
          <span className="view-count">
            {counts[kind + id]?.toLocaleString() ?? "—"}
          </span>
        </Segment.Item>
      ))}
    </Segment>
  );
  return (
    <div className="space-y-5">
      {error && (
        <p className="text-danger" role="alert">
          {error}
        </p>
      )}
      {view === "applied" ? (
        <AppliedView
          key={kind}
          kind={kind}
          onTotal={onTotal}
          navigation={navigation}
          totals={<ApplicationTotals key={kind} kind={kind} />}
        />
      ) : (
        <Board
          key={`${view}:${kind}`}
          kind={kind}
          trash={view === "trash"}
          navigation={navigation}
          onTotal={onTotal}
          query={query}
          setQuery={setQuery}
        />
      )}
    </div>
  );
}
