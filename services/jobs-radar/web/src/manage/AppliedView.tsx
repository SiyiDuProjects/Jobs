import { useMemo, useState } from "react";
import { Button, Card, Chip, Input, TextField } from "@heroui/react";
import { DataGrid, type DataGridColumn } from "@heroui-pro/react";
import { ApplicationEditor, ProgressEditor } from "./application-editors";
import { useManagement } from "./store";
import {
  appRows,
  statuses,
  exportCSV,
  safeHref,
  progressLabel,
  type AppRow,
  type Application,
} from "./model";
import { ApplicationFlow } from "./ApplicationFlow";
import { dateLabel } from "./application-format";
import { Choice, Dialog, download, Field } from "./components";

export function PendingMail() {
  const { docs } = useManagement();
  const rows = docs.applicationProgressReview?.value || [];
  if (!rows.length) return null;
  return (
    <Card className="mb-4">
      <Card.Content>
        <details className="text-sm">
          <summary>待核对邮件 · {rows.length} 条</summary>
          <p className="text-muted py-2">关联到具体申请前，不重复计入统计。</p>
          {rows.map((r: any, i: number) => (
            <div
              key={r.message_id || i}
              className="border-t border-separator py-2"
            >
              <strong>
                {r.companyName || r.candidates?.[0]?.companyName} ·{" "}
                {r.label || r.stage}
              </strong>
              <p>{r.summary}</p>
              {safeHref(r.email_url) && (
                <a
                  className="text-accent underline"
                  href={safeHref(r.email_url)}
                  target="_blank"
                  rel="noreferrer"
                >
                  查看邮件
                </a>
              )}
            </div>
          ))}
        </details>
      </Card.Content>
    </Card>
  );
}
export function AppliedView() {
  const { docs, profiles, current, applicationsLoading } = useManagement();
  const all: Application[] = docs.appliedList?.value || [];
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [flow, setFlow] = useState<{ label: string; ids: string[] } | null>(
    null,
  );
  const [dialog, setDialog] = useState<{ type: string; row?: AppRow } | null>(
    null,
  );
  const rows = useMemo(
    () =>
      appRows(all)
        .filter(
          (r) =>
            `${r.job?.title || r.jobTitle} ${r.job?.company || r.companyName}`
              .toLowerCase()
              .includes(query.trim().toLowerCase()) &&
            (status === "all" || (r.progress?.stage || r.status) === status) &&
            (!from || +new Date(r.date) >= +new Date(from + "T00:00:00")) &&
            (!to || +new Date(r.date) <= +new Date(to + "T23:59:59.999")),
        )
        .sort((a, b) => +new Date(b.date) - +new Date(a.date)),
    [all, query, status, from, to],
  );
  const visible = flow
    ? rows.filter((r) => flow.ids.includes(r.id || r.key))
    : rows;
  const pages = Math.max(1, Math.ceil(visible.length / 30)),
    active = Math.min(page, pages),
    close = () => setDialog(null);
  const columns: DataGridColumn<AppRow>[] = [
    {
      id: "job",
      header: "岗位",
      isRowHeader: true,
      minWidth: 260,
      cell: (r) => (
        <div>
          <a
            className="font-medium hover:underline"
            href={safeHref(r.job?.apply_url || r.jobLink) || undefined}
            target="_blank"
            rel="noreferrer"
          >
            {r.job?.title || r.jobTitle}
          </a>
          <div className="text-muted text-sm mt-1">
            {r.job?.locations?.join(" · ") || ""}
            {!r.job && (
              <Chip size="sm" variant="soft">
                外部投递
              </Chip>
            )}
          </div>
        </div>
      ),
    },
    {
      id: "company",
      header: "公司",
      minWidth: 140,
      cell: (r) => r.job?.company || r.companyName,
    },
    {
      id: "status",
      header: "进展",
      minWidth: 140,
      cell: (r) => (
        <Button
          size="sm"
          variant="secondary"
          onPress={() => setDialog({ type: "progress", row: r })}
        >
          {progressLabel(r)}
        </Button>
      ),
    },
    {
      id: "date",
      header: "投递时间",
      minWidth: 120,
      cell: (r) => dateLabel(r.date),
    },
    {
      id: "profile",
      header: "资料",
      accessorKey: "profileName",
      minWidth: 100,
    },
    {
      id: "actions",
      header: "",
      width: 80,
      cell: (r) => (
        <Button
          size="sm"
          variant="ghost"
          onPress={() => setDialog({ type: "edit", row: r })}
        >
          编辑
        </Button>
      ),
    },
  ];
  return (
    <section aria-label="已投递" className="space-y-4">
      <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(200px,1fr)_180px_auto]">
        <TextField
          aria-label="搜索投递"
          value={query}
          onChange={(v) => {
            setQuery(v);
            setFlow(null);
            setPage(1);
          }}
          className="min-w-0 sm:col-span-2 lg:col-span-1"
        >
          <Input placeholder="搜索公司或岗位" />
        </TextField>
        <Choice
          label="进展"
          hideLabel
          value={status}
          options={{
            all: "全部进展",
            ...statuses,
            applied: "等待回复",
            phone_screen: "初筛",
          }}
          onChange={(v) => {
            setStatus(v);
            setFlow(null);
            setPage(1);
          }}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            onPress={() => setDialog({ type: "date" })}
          >
            {from || to ? `${from || "…"} — ${to || "…"}` : "投递日期"}
          </Button>
          <Button
            variant="secondary"
            onPress={() => setDialog({ type: "add" })}
          >
            手动补录
          </Button>
          <Button
            variant="ghost"
            isDisabled={!all.length}
            onPress={() =>
              download(
                "applications.csv",
                exportCSV(all),
                "text/csv;charset=utf-8",
              )
            }
          >
            导出 CSV
          </Button>
        </div>
      </div>
      <ApplicationFlow
        rows={rows.map((r) => ({ ...r, id: r.id || r.key }))}
        onSelect={(label, ids) => {
          setFlow(ids ? { label, ids } : null);
          setPage(1);
        }}
      />
      {flow && (
        <Button size="sm" variant="secondary" onPress={() => setFlow(null)}>
          清除图表筛选：{flow.label} ×
        </Button>
      )}
      <DataGrid
        aria-label="投递记录"
        contentClassName="min-w-[840px]"
        data={visible.slice((active - 1) * 30, active * 30)}
        columns={columns}
        getRowId={(r) => r.key}
        renderEmptyState={() =>
          applicationsLoading ? "正在读取投递记录…" : all.length ? "没有符合筛选的投递" : "暂无投递记录"
        }
      />
      <div className="flex items-center justify-between text-sm text-muted">
        <span>
          共 {visible.length} 条 · 第 {active} / {pages} 页
        </span>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            isDisabled={active === 1}
            onPress={() => setPage(active - 1)}
          >
            上一页
          </Button>
          <Button
            variant="ghost"
            isDisabled={active === pages}
            onPress={() => setPage(active + 1)}
          >
            下一页
          </Button>
        </div>
      </div>
      {dialog?.type === "progress" && (
        <ProgressEditor row={dialog.row!} onClose={close} />
      )}
      {(dialog?.type === "edit" || dialog?.type === "add") && (
        <ApplicationEditor
          row={dialog.row}
          all={all}
          profiles={profiles}
          profileId={current?.id}
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
    </section>
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
      title="投递日期"
      onClose={onClose}
      saveLabel="应用"
      onSave={async () => {
        if (a && b && a > b) throw Error("开始日期不能晚于结束日期");
        onApply(a, b);
      }}
    >
      <Field type="date" label="从" value={a} onChange={setA} />
      <Field type="date" label="至" value={b} onChange={setB} />
      <Button
        variant="ghost"
        onPress={() => {
          setA("");
          setB("");
        }}
      >
        不限日期
      </Button>
    </Dialog>
  );
}
