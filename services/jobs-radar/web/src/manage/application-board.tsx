import { dateLabel } from "./application-format";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Input, TextField } from "@heroui/react";
import {
  DataGrid,
  Kanban,
  Segment,
  useKanban,
  useKanbanColumn,
  type DataGridColumn,
  type UseKanbanReturn,
} from "@heroui-pro/react";
import { KPI } from "@heroui-pro/react/kpi";
import { BarChart } from "@heroui-pro/react/bar-chart";
import { ApplicationFlow } from "./ApplicationFlow";
import { api, store, useManagement } from "./store";
import {
  appRows,
  chartData,
  exportCSV,
  localDay,
  parseCSV,
  safeHref,
  statuses,
  displayStatuses,
  displayStage,
  progressLabel,
  nextStages,
  type Application,
  type AppRow,
} from "./model";
import {
  act,
  Choice,
  Dialog,
  download,
  Field,
  Menu,
  Upload,
} from "./components";

export function ApplicationBoard({
  rows,
  all,
  onEdit,
}: {
  rows: AppRow[];
  all: Application[];
  onEdit: (r: AppRow) => void;
}) {
  const [columns, setColumns] = useState<string[]>(() => {
    try {
      const value = JSON.parse(localStorage.getItem("boardColumns") || "null");
      if (
        Array.isArray(value) &&
        value.length === Object.keys(displayStatuses).length &&
        new Set(value).size === value.length &&
        value.every((s) => s in displayStatuses)
      )
        return value;
    } catch {}
    return Object.keys(displayStatuses);
  });
  const draggingColumn = useRef<string | null>(null);
  const reorderColumn = (id: string, to: number) => {
    const next = [...columns],
      from = next.indexOf(id);
    if (from < 0 || to < 0 || to >= next.length || from === to) return;
    next.splice(from, 1);
    next.splice(to, 0, id);
    setColumns(next);
    localStorage.setItem("boardColumns", JSON.stringify(next));
  };
  const { docs } = useManagement(),
    order = docs.boardCardOrder?.value || {};
  const ordered = Object.keys(displayStatuses).flatMap((s) => {
    const ids: string[] = order[s] || [];
    return rows
      .filter((r) => (r.boardStage || displayStage(r)) === s)
      .sort(
        (a, b) =>
          (ids.indexOf(a.key) < 0 ? Infinity : ids.indexOf(a.key)) -
          (ids.indexOf(b.key) < 0 ? Infinity : ids.indexOf(b.key)),
      );
  });
  const kanban = useKanban<AppRow>({
    initialItems: ordered,
    getKey: (r) => r.key,
    getColumn: (r) => r.boardStage || displayStage(r),
    setColumn: (r, boardStage) => {
      if (boardStage === "no_answer" && displayStage(r) !== "no_answer") {
        onEdit(r);
        return r;
      }
      return { ...r, boardStage };
    },
  });
  const persist = (next: AppRow[]) => {
    const changes = next.filter((r) =>
      all.some(
        (a) =>
          a.id === r.id &&
          displayStage(a) !== (r.boardStage || displayStage(r)),
      ),
    );
    const nextOrder = Object.fromEntries(
      Object.keys(displayStatuses).map((s) => [
        s,
        [
          ...next
            .filter((r) => (r.boardStage || displayStage(r)) === s)
            .map((r) => r.key),
          ...(order[s] || []).filter(
            (id: string) => !next.some((r) => r.key === id),
          ),
        ],
      ]),
    );
    act(
      (async () => {
        for (const row of changes) {
          const before = all.find((a) => a.id === row.id)!;
          const target = row.boardStage || displayStage(row);
          if (target === "no_answer")
            throw Error(
              "No Answer 是汇总分类；请点击申请状态，选择要修正的原始记录。",
            );
          await store.updateProgress(before, {
            stage: target,
            summary: `手动移动到 ${displayStatuses[target as keyof typeof displayStatuses]}`,
          });
        }
        await store.write({ boardCardOrder: nextOrder });
      })(),
    );
  };
  // The Pro hook owns only drag state. Persist its completed list changes once.
  const last = useRef(kanban.list.items);
  useEffect(() => {
    if (last.current === kanban.list.items) return;
    last.current = kanban.list.items;
    persist(kanban.list.items);
  }, [kanban.list.items]);
  return (
    <Kanban>
      {columns.map((id, index) => (
        <BoardColumn
          key={id}
          id={id}
          label={displayStatuses[id as keyof typeof displayStatuses]}
          kanban={kanban}
          onEdit={onEdit}
          onColumnDrag={() => {
            draggingColumn.current = id;
          }}
          onColumnDrop={() => {
            if (draggingColumn.current)
              reorderColumn(draggingColumn.current, index);
            draggingColumn.current = null;
          }}
          onColumnMove={(direction) => reorderColumn(id, index + direction)}
        />
      ))}
    </Kanban>
  );
}
function BoardColumn({
  id,
  label,
  kanban,
  onEdit,
  onColumnDrag,
  onColumnDrop,
  onColumnMove,
}: {
  id: string;
  label: string;
  kanban: UseKanbanReturn<AppRow>;
  onEdit: (r: AppRow) => void;
  onColumnDrag: () => void;
  onColumnDrop: () => void;
  onColumnMove: (direction: number) => void;
}) {
  const { items, dragAndDropHooks } = useKanbanColumn(kanban, id);
  return (
    <Kanban.Column onDragOver={(e) => e.preventDefault()} onDrop={onColumnDrop}>
      <Kanban.ColumnHeader
        draggable
        onDragStart={onColumnDrag}
        tabIndex={0}
        aria-label={`${label}; drag to reorder, or Alt and arrow keys`}
        onKeyDown={(e) => {
          if (e.altKey && ["ArrowLeft", "ArrowRight"].includes(e.key)) {
            e.preventDefault();
            onColumnMove(e.key === "ArrowLeft" ? -1 : 1);
          }
        }}
      >
        <Kanban.ColumnTitle>{label}</Kanban.ColumnTitle>
        <Kanban.ColumnCount>{items.length}</Kanban.ColumnCount>
      </Kanban.ColumnHeader>
      <Kanban.ColumnBody>
        <Kanban.CardList
          aria-label={label}
          items={items}
          dragAndDropHooks={dragAndDropHooks}
          className="max-h-[32rem] overflow-y-auto"
          renderEmptyState={() => "Nothing here yet."}
        >
          {(item) => (
            <Kanban.Card
              id={item.key}
              textValue={item.jobTitle}
              onAction={() => onEdit(item)}
            >
              <div className="font-medium">{item.jobTitle}</div>
              <div className="text-muted text-sm">{item.companyName}</div>
              <div className="text-sm">{progressLabel(item)}</div>
              <div className="flex justify-between gap-2 text-xs text-muted">
                <span>{dateLabel(item.date)}</span>
                <span>{item.profileName}</span>
              </div>
            </Kanban.Card>
          )}
        </Kanban.CardList>
      </Kanban.ColumnBody>
    </Kanban.Column>
  );
}
