import { dateLabel } from "./application-format";
import {
  ApplicationEditor,
  ProgressEditor,
  ImportApplications,
} from "./application-editors";
import { ApplicationBoard } from "./application-board";
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

export function Applications() {
  const { docs, profiles, current } = useManagement(),
    all: Application[] = docs.appliedList?.value || [];
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState("all"),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [view, setView] = useState("list"),
    [chartView, setChartView] = useState("flow"),
    [flowSelection, setFlowSelection] = useState<{
      label: string;
      ids: string[];
    } | null>(null),
    [page, setPage] = useState(1),
    [dialog, setDialog] = useState<{ type: string; row?: AppRow } | null>(null);
  const searched = useMemo(
    () =>
      appRows(all)
        .filter(
          (row) =>
            (row.jobTitle + " " + row.companyName)
              .toLowerCase()
              .includes(query.trim().toLowerCase()) &&
            (!from || new Date(row.date) >= new Date(from + "T00:00:00")) &&
            (!to ||
              new Date(row.date) <
                new Date(new Date(to + "T00:00:00").getTime() + 86400000)),
        )
        .sort((a, b) => (+new Date(b.date) || 0) - (+new Date(a.date) || 0)),
    [all, query, from, to],
  );
  const filtered = searched.filter(
      (row) =>
        (!flowSelection || flowSelection.ids.includes(row.id || "")) &&
        (view === "board" || status === "all" || displayStage(row) === status),
    ),
    pageCount = Math.max(1, Math.ceil(filtered.length / 30)),
    activePage = Math.min(page, pageCount);
  const chart = useMemo(
    () => chartData(filtered, from, to),
    [filtered, from, to],
  );
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const startMonth = new Date(startToday);
  startMonth.setDate(startMonth.getDate() - 29);
  const stats = [
    {
      title: "Today's Applications",
      value: all.filter((r) => new Date(r.date) >= startToday).length,
    },
    {
      title: "Monthly Applications",
      value: all.filter((r) => new Date(r.date) >= startMonth).length,
      hint: "Last 30 days",
    },
    { title: "Total Applications", value: all.length },
  ];
  const edit = (row: AppRow) => setDialog({ type: "edit", row });
  const columns: DataGridColumn<AppRow>[] = [
    {
      id: "job",
      header: "Job",
      isRowHeader: true,
      minWidth: 240,
      cell: (r) =>
        safeHref(r.jobLink) ? (
          <a
            className="font-medium hover:underline"
            href={safeHref(r.jobLink)}
            target="_blank"
            rel="noreferrer"
          >
            {r.jobTitle}
          </a>
        ) : (
          r.jobTitle
        ),
    },
    {
      id: "company",
      header: "Company",
      minWidth: 140,
      accessorKey: "companyName",
    },
    {
      id: "status",
      header: "Status",
      minWidth: 150,
      cell: (r) => (
        <Button
          variant="ghost"
          size="sm"
          onPress={() => setDialog({ type: "progress", row: r })}
          aria-label={"更新进度：" + r.jobTitle}
        >
          {progressLabel(r)}
        </Button>
      ),
    },
    {
      id: "profile",
      header: "Profile",
      accessorKey: "profileName",
      minWidth: 100,
    },
    {
      id: "applied",
      header: "Applied",
      minWidth: 125,
      cell: (r) => <span className="text-muted">{dateLabel(r.date)}</span>,
    },
    {
      id: "actions",
      header: "",
      width: 64,
      cell: (r) => (
        <Menu
          label="⋯"
          ariaLabel={"Actions for " + r.jobTitle}
          items={[
            {
              id: "progress",
              label: "进度与历史",
              action: () => setDialog({ type: "progress", row: r }),
            },
            { id: "update", label: "Update", action: () => edit(r) },
            {
              id: "delete",
              label: "Delete",
              danger: true,
              action: () => setDialog({ type: "delete", row: r }),
            },
          ]}
        />
      ),
    },
  ];
  const close = () => setDialog(null);
  return (
    <>
      {!!docs.applicationProgressReview?.value?.length && (
        <details className="text-sm rounded-xl bg-surface-secondary p-3">
          <summary>
            待核对邮件 · {docs.applicationProgressReview.value.length} 条
          </summary>
          <p className="text-muted py-2">
            进展已保留；关联到具体申请前，不重复计入统计。
          </p>
          {docs.applicationProgressReview.value.map((item: any) => (
            <div key={item.job_id} className="border-t border-separator py-2">
              <strong>
                {item.companyName || item.candidates?.[0]?.companyName} ·{" "}
                {item.label || item.stage}
              </strong>
              <p>{item.summary}</p>
              <a
                className="underline"
                href={
                  "https://mail.google.com/mail/u/?authuser=siyidu.work%40gmail.com#all/" +
                  item.message_id
                }
                target="_blank"
                rel="noreferrer"
              >
                查看邮件
              </a>
            </div>
          ))}
        </details>
      )}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">Applications</h1>
        <Menu
          items={[
            {
              id: "add",
              label: "Add",
              action: () => setDialog({ type: "add" }),
            },
            {
              id: "import",
              label: "Import",
              action: () => setDialog({ type: "import" }),
            },
            {
              id: "export",
              label: "Export",
              disabled: !all.length,
              action: () =>
                download(
                  "applications.csv",
                  exportCSV(all),
                  "text/csv;charset=utf-8",
                ),
            },
            {
              id: "delete-all",
              label: "Delete All",
              danger: true,
              disabled: !all.length,
              action: () => setDialog({ type: "delete-all" }),
            },
          ]}
        />
      </div>
      <div className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
        <div className="grid grid-cols-3 gap-3 md:grid-cols-1">
          {stats.map((stat) => (
            <KPI key={stat.title}>
              <KPI.Header>
                <KPI.Title>{stat.title}</KPI.Title>
              </KPI.Header>
              <KPI.Content>
                <KPI.Value value={stat.value} maximumFractionDigits={0} />
              </KPI.Content>
              {stat.hint && <KPI.Footer>{stat.hint}</KPI.Footer>}
            </KPI>
          ))}
        </div>
        <div className="min-w-0 self-center w-full">
          <div className="flex items-center justify-between gap-3 mb-2">
            <h2 className="font-medium text-sm">
              {chartView === "flow" ? "申请流向" : "投递趋势"}
            </h2>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={chartView === "flow" ? "secondary" : "ghost"}
                aria-pressed={chartView === "flow"}
                onPress={() => setChartView("flow")}
              >
                申请流向
              </Button>
              <Button
                size="sm"
                variant={chartView === "trend" ? "secondary" : "ghost"}
                aria-pressed={chartView === "trend"}
                onPress={() => setChartView("trend")}
              >
                投递趋势
              </Button>
            </div>
          </div>
          {chartView === "trend" ? (
            <BarChart data={chart.data} height={300}>
              <BarChart.Grid vertical={false} />
              <BarChart.XAxis
                dataKey="date"
                tickFormatter={(v) =>
                  new Date(v + "T00:00:00").toLocaleDateString("en-US", {
                    month: "short",
                    ...(chart.bucket === "month"
                      ? { year: "2-digit" }
                      : { day: "numeric" }),
                  })
                }
              />
              <BarChart.YAxis allowDecimals={false} width={36} />
              <BarChart.Bar
                dataKey="count"
                name="Applications"
                fill="var(--accent)"
                radius={[4, 4, 0, 0]}
                maxBarSize={28}
              />
              <BarChart.Tooltip content={<BarChart.TooltipContent />} />
            </BarChart>
          ) : (
            <ApplicationFlow
              rows={searched}
              onSelect={(label, ids) => {
                setFlowSelection(ids ? { label, ids } : null);
                setStatus("all");
                setPage(1);
              }}
            />
          )}
        </div>
      </div>
      {flowSelection && (
        <div className="flex items-center gap-3 text-sm">
          <span>
            当前查看：{flowSelection.label} · {filtered.length} 条
          </span>
          <Button
            size="sm"
            variant="ghost"
            onPress={() => setFlowSelection(null)}
          >
            清除节点筛选
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <TextField
          aria-label="Search applications"
          className="min-w-52 flex-1"
          value={query}
          onChange={(v) => {
            setQuery(v);
            setFlowSelection(null);
            setPage(1);
          }}
        >
          <Input placeholder="Search applications…" />
        </TextField>
        {view === "list" && (
          <div className="w-44">
            <Choice
              label="Application status"
              hideLabel
              value={status}
              onChange={(v) => {
                setStatus(v);
                setPage(1);
              }}
              options={{ all: "Any status", ...displayStatuses }}
            />
          </div>
        )}
        <Button variant="secondary" onPress={() => setDialog({ type: "date" })}>
          {from || to ? `${from || "…"} — ${to || "…"}` : "Any date"}
        </Button>
        <Segment
          aria-label="Application view"
          selectedKey={view}
          onSelectionChange={(key) => {
            setView(String(key));
            setStatus("all");
          }}
        >
          <Segment.Item id="list">List</Segment.Item>
          <Segment.Item id="board">Board</Segment.Item>
        </Segment>
      </div>
      {view === "list" ? (
        <>
          <DataGrid
            aria-label="Applications"
            data={filtered.slice((activePage - 1) * 30, activePage * 30)}
            columns={columns}
            getRowId={(r) => r.key}
            renderEmptyState={() =>
              all.length
                ? "No applications match your filters."
                : "Your submitted job applications will appear here."
            }
          />
          <div className="flex justify-between items-center text-sm text-muted">
            <span>
              {filtered.length
                ? `${(activePage - 1) * 30 + 1}–${Math.min(activePage * 30, filtered.length)} of ${filtered.length}`
                : "0 applications"}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                isDisabled={activePage === 1}
                onPress={() => setPage(activePage - 1)}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                isDisabled={activePage === pageCount}
                onPress={() => setPage(activePage + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      ) : (
        <ApplicationBoard
          key={JSON.stringify([filtered, docs.boardCardOrder?.value])}
          rows={filtered}
          all={all}
          onEdit={(row) => setDialog({ type: "progress", row })}
        />
      )}
      {dialog?.type === "progress" && (
        <ProgressEditor
          key={dialog.row!.id}
          row={dialog.row!}
          onClose={close}
        />
      )}
      {(dialog?.type === "add" || dialog?.type === "edit") && (
        <ApplicationEditor
          row={dialog.row}
          profiles={profiles}
          profileId={current?.id}
          all={all}
          onClose={close}
        />
      )}
      {dialog?.type === "date" && (
        <DateFilter
          from={from}
          to={to}
          onClose={close}
          onApply={(a, b) => {
            setFrom(a);
            setTo(b);
            setPage(1);
          }}
        />
      )}
      {dialog?.type === "import" && (
        <ImportApplications all={all} onClose={close} />
      )}
      {(dialog?.type === "delete" || dialog?.type === "delete-all") && (
        <Dialog
          title={
            dialog.type === "delete"
              ? "Delete application?"
              : "Delete all applications?"
          }
          onClose={close}
          danger
          saveLabel={dialog.type === "delete" ? "Delete" : "Delete All"}
          onSave={() =>
            store.mutateApplications(
              (dialog.type === "delete" ? [dialog.row!] : all).map((row) => ({
                action: "delete",
                application_id: row.id,
                expected_version: row.version,
              })),
            )
          }
        >
          <p>This action cannot be undone.</p>
          <p>
            {dialog.type === "delete"
              ? dialog.row?.jobTitle
              : `All ${all.length} applications will be deleted.`}
          </p>
        </Dialog>
      )}
    </>
  );
}
function DateFilter({
  from,
  to,
  onClose,
  onApply,
}: {
  from: string;
  to: string;
  onClose: () => void;
  onApply: (a: string, b: string) => void;
}) {
  const [a, setA] = useState(from),
    [b, setB] = useState(to);
  return (
    <Dialog
      title="Filter by date"
      onClose={onClose}
      saveLabel="Apply"
      onSave={async () => {
        if (a && b && a > b) throw Error("Start date must precede end date");
        onApply(a, b);
      }}
    >
      <div className="flex flex-wrap gap-2">
        {[3, 7, 15, 30].map((days) => (
          <Button
            key={days}
            variant="secondary"
            onPress={() => {
              const d = new Date();
              d.setDate(d.getDate() - days + 1);
              setA(localDay(d));
              setB(localDay(new Date()));
            }}
          >
            {days === 1 ? "Today" : `Last ${days} days`}
          </Button>
        ))}
        <Button
          variant="ghost"
          onPress={() => {
            setA("");
            setB("");
          }}
        >
          Any date
        </Button>
      </div>
      <Field label="Start date" type="date" value={a} onChange={setA} />
      <Field label="End date" type="date" value={b} onChange={setB} />
    </Dialog>
  );
}
