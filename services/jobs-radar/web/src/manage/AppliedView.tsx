import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, Chip, Dropdown, Label } from "@heroui/react";
import { ApplicationEditor, ProgressEditor } from "./application-editors";
import { store, useManagement } from "./store";
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
import { Dialog, download, Field } from "./components";
import { profileForKind } from "./kind-profiles";
import { JobList } from "../JobList";
import { ActionMenu, ListToolbar, ListPagination } from "../ListControls";

export function AppliedView({
  kind,
  navigation,
  totals,
  onTotal,
}: {
  kind: "newgrad" | "internship";
  navigation: ReactNode;
  totals: ReactNode;
  onTotal?: (value: number) => void;
}) {
  const { docs, profiles, applicationsLoading } = useManagement();
  const all: Application[] = docs.appliedList?.value || [];
  const scoped = useMemo(() => all.filter((r) => r.kind === kind), [all, kind]);
  useEffect(() => {
    if (!applicationsLoading) onTotal?.(scoped.length);
  }, [applicationsLoading, scoped.length, onTotal]);
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
      appRows(scoped)
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
    [scoped, query, status, from, to],
  );
  const visible = flow
    ? rows.filter((r) => flow.ids.includes(r.id || r.key))
    : rows;
  const pages = Math.max(1, Math.ceil(visible.length / 30)),
    active = Math.min(page, pages),
    close = () => setDialog(null);

  const progressOptions = {
    all: "全部进展",
    ...statuses,
    applied: "等待回复",
    phone_screen: "HR 面试",
  };
  return (
    <section aria-label="已投递">
      <ListToolbar
        navigation={navigation}
        totals={totals}
        filters={
          <>
            <Dropdown>
              <Button size="sm" variant="secondary" aria-label="筛选投递进展">
                {progressOptions[status as keyof typeof progressOptions] ||
                  "进展"}
              </Button>
              <Dropdown.Popover>
                <Dropdown.Menu
                  aria-label="投递进展"
                  selectionMode="single"
                  selectedKeys={[status]}
                  onAction={(key) => {
                    setStatus(String(key));
                    setFlow(null);
                    setPage(1);
                  }}
                >
                  {Object.entries(progressOptions).map(([key, label]) => (
                    <Dropdown.Item key={key} id={key} textValue={label}>
                      <Label>{label}</Label>
                    </Dropdown.Item>
                  ))}
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
            {flow && (
              <Button
                size="sm"
                variant="secondary"
                onPress={() => setFlow(null)}
                aria-label={`清除图表筛选：${flow.label}`}
              >
                {flow.label} ×
              </Button>
            )}
          </>
        }
        date={
          <Button
            size="sm"
            variant="secondary"
            onPress={() => setDialog({ type: "date" })}
          >
            {from || to
              ? `${from ? dateLabel(from) : "…"}–${to ? dateLabel(to) : "…"}`
              : "投递日期"}
          </Button>
        }
        query={query}
        onQuery={(value) => {
          setQuery(value);
          setFlow(null);
          setPage(1);
        }}
        searchLabel="搜索投递"
        menu={[
          {
            id: "add",
            label: "手动补录",
            onAction: () => setDialog({ type: "add" }),
          },
          {
            id: "export",
            label: "导出 CSV",
            disabled: !scoped.length,
            onAction: () =>
              download(
                `applications-${kind}.csv`,
                exportCSV(scoped),
                "text/csv;charset=utf-8",
              ),
          },
          {
            id: "flow",
            label: "投递进展图",
            onAction: () => setDialog({ type: "flow" }),
          },
        ]}
      />
      <JobList
        label="投递记录"
        dateLabel="投递时间"
        extraLabel="进展"
        empty={
          applicationsLoading
            ? "正在读取投递记录…"
            : scoped.length
              ? "没有符合筛选的投递"
              : "暂无投递记录"
        }
        rows={visible.slice((active - 1) * 30, active * 30).map((r) => ({
          id: r.key,
          company: r.job?.company || r.companyName,
          title: r.job?.title || r.jobTitle,
          locations: r.job?.locations || [],
          date: dateLabel(r.date),
          badge: !r.job ? (
            <Chip size="sm" variant="soft" className="job-badge">
              外部投递
            </Chip>
          ) : undefined,
          extra: (
            <Chip size="sm" variant="soft">
              {progressLabel(r)}
            </Chip>
          ),
          onOpen: () => setDialog({ type: "view", row: r }),
          actions: (
            <ActionMenu
              label={`${r.job?.title || r.jobTitle}的操作`}
              items={[
                {
                  id: "progress",
                  label: "更新进展",
                  onAction: () => setDialog({ type: "progress", row: r }),
                },
                {
                  id: "edit",
                  label: "编辑",
                  onAction: () => setDialog({ type: "edit", row: r }),
                },
                {
                  id: "delete",
                  label: "删除",
                  danger: true,
                  onAction: () => setDialog({ type: "delete", row: r }),
                },
              ]}
            />
          ),
        }))}
      />
      <ListPagination page={active} pages={pages} onPage={setPage} />
      {dialog?.type === "progress" && (
        <ProgressEditor row={dialog.row!} onClose={close} />
      )}
      {(dialog?.type === "edit" || dialog?.type === "add") && (
        <ApplicationEditor
          row={dialog.row}
          kind={kind}
          profiles={profiles}
          profileId={profileForKind(
            kind,
            profiles,
            docs.jobsKindProfiles?.value,
          )}
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
      {dialog?.type === "flow" && (
        <Dialog title="投递进展" onClose={close} wide>
          <ApplicationFlow
            rows={rows.map((r) => ({ ...r, id: r.id || r.key }))}
            onSelect={(label, ids) => {
              setFlow(ids ? { label, ids } : null);
              setPage(1);
              close();
            }}
          />
        </Dialog>
      )}
      {dialog?.type === "delete" && (
        <Dialog
          title="删除投递记录"
          danger
          onClose={close}
          saveLabel="删除"
          onSave={async () => {
            await store.mutateApplications([
              {
                action: "delete",
                application_id: dialog.row!.id,
                expected_version: dialog.row!.version,
              },
            ]);
          }}
        >
          <p>
            删除 {dialog.row!.companyName} · {dialog.row!.jobTitle} 的投递记录？
          </p>
        </Dialog>
      )}
      {dialog?.type === "view" && (
        <Dialog
          title={dialog.row!.job?.title || dialog.row!.jobTitle}
          onClose={close}
        >
          <p>{dialog.row!.job?.company || dialog.row!.companyName}</p>
          <p className="text-muted">
            {dialog.row!.job?.locations?.join(" · ") || "外部投递"}
          </p>
          <p>
            投递时间：{dateLabel(dialog.row!.date)} ·{" "}
            {progressLabel(dialog.row!)}
          </p>
          {safeHref(dialog.row!.job?.apply_url || dialog.row!.jobLink) && (
            <a
              className="button button--secondary button--sm"
              target="_blank"
              rel="noreferrer"
              href={safeHref(
                dialog.row!.job?.apply_url || dialog.row!.jobLink,
              )!}
            >
              查看岗位
            </a>
          )}
        </Dialog>
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
        variant="secondary"
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
