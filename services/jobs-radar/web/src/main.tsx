import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SiteApp } from "./SiteApp";
import type { BoardProps } from "./JobWorkspace";
import {
  Alert,
  Button,
  Input,
  Label,
  Modal,
  TextArea,
  TextField,
} from "@heroui/react";
import "./style.css";
import { ExtensionSync } from "./ExtensionSync";
import { createBoardLoader } from "./board-loader";
import { DateWindowFilter } from "./DateWindowFilter";
import { addedRange } from "./date-window";
import { readBoardFilters, saveBoardFilters } from "./board-filters";
import { ApplicationTotals } from "./ApplicationTotals";

import { JobTable } from "./JobTable";
import { ListToolbar, ListPagination } from "./ListControls";
import {
  api,
  defaults,
  splitCompanies,
  type Job,
  type UndoTarget,
  type Listing,
  type Filters,
} from "./job-board-model";
export function JobsBoard({
  kind,
  trash,
  navigation,
  query,
  setQuery,
  onTotal,
}: BoardProps) {
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const auth = true;
  const [data, setData] = useState<Listing | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [exclusionsOpen, setExclusionsOpen] = useState(false),
    [notice, setNotice] = useState("");
  const [filters, setFilters] = useState<Filters>(() => {
    if (trash)
      return {
        ...defaults,
        company_internship: "",
        company_newgrad: "",
        region: "",
        text: query,
      };
    return { ...readBoardFilters(localStorage, kind), text: query };
  });
  const [excludedCompanies, setExcludedCompanies] = useState("");
  const [action, setAction] = useState<{ type: "trash"; job: Job } | null>(
      null,
    ),
    [detail, setDetail] = useState(""),
    [actionError, setActionError] = useState(""),
    [saving, setSaving] = useState(false);
  const [undo, setUndo] = useState<UndoTarget | null>(null);
  const mutation = useRef(false),
    keys = useRef(new Map<string, string>());
  const serial = useRef(0),
    actionRef = useRef(action);
  actionRef.current = action;
  const loader = useRef(createBoardLoader(api)).current;
  const load = useCallback(async () => {
    if (kindRef.current !== kind) return;
    const seq = ++serial.current,
      current = () => seq === serial.current;
    setBusy(true);
    setError("");
    const { added_date, ...rest } = filters;
    const params = new URLSearchParams({
      ...rest,
      ...addedRange(trash ? "" : added_date),
      page: String(filters.page),
      kind,
      view: trash ? "trash" : "jobs",
      page_size: "50",
      status: trash ? "" : "unsubmitted",
    });
    try {
      const v = await loader.jobs(params);
      if (current()) {
        if (filters.page > 1 && !v.jobs.length)
          setFilters((f) => ({ ...f, page: 1 }));
        else setData(v);
      }
    } catch (e) {
      if (current()) setError((e as Error).message);
    } finally {
      if (current()) setBusy(false);
    }
  }, [filters, kind, loader, trash]);
  useEffect(
    () => () => {
      ++serial.current;
      loader.cancel();
    },
    [loader],
  );
  useEffect(() => {
    if (auth) void load();
  }, [auth, load]);
  useEffect(() => {
    if (!trash) saveBoardFilters(localStorage, kind, filters);
  }, [filters, kind, trash]);
  useEffect(() => {
    const timer = setTimeout(
      () =>
        setFilters((f) =>
          f.text === query ? f : { ...f, text: query, page: 1 },
        ),
      300,
    );
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!auth) return;
    const refresh = () => {
      if (!actionRef.current && document.visibilityState === "visible")
        void load();
    };
    const timer = setInterval(refresh, 60000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [auth, load]);
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(
        () => {
          setNotice("");
          setUndo(null);
        },
        undo ? 30000 : 4000,
      );
      return () => clearTimeout(timer);
    }
  }, [notice, undo]);
  const companyKey =
    kind === "newgrad" ? "company_newgrad" : "company_internship";
  function toggleRegion(selected: boolean) {
    setFilters((f) => ({
      ...f,
      region: selected ? "focus_remote" : "",
      page: 1,
    }));
  }
  function filter(key: keyof Filters, value: string) {
    setFilters((f) => ({ ...f, [key]: value, page: 1 }));
  }
  function open(type: "trash", job: Job) {
    setDetail("");
    setActionError("");
    setAction({ type, job });
  }
  function review(job: Job, decision: "trash" | "restore", text: string) {
    return {
      action: "review",
      job_id: job.id,
      kind,
      decision,
      reason: decision === "trash" ? "manual" : "owner_restore",
      detail: text,
      evidence:
        decision === "trash"
          ? [
              {
                url: job.apply_url || job.source_url,
                quote: job.title,
                observed_at: new Date().toISOString(),
              },
            ]
          : [],
      expected_fingerprint: job.fingerprint,
      expected_version: job.review_version,
      key: crypto.randomUUID(),
    };
  }
  async function send(payload: unknown) {
    return api("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
  async function restore(job: Job) {
    if (saving) return;
    setSaving(true);
    try {
      await send(review(job, "restore", "用户恢复并人工保留"));
      setNotice("已恢复，自动初筛不会再次删除");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function submission(job: Job) {
    if (mutation.current) return;
    mutation.current = true;
    setSaving(true);
    setError("");
    try {
      const token = "submitted:" + job.id + ":" + job.application_version;
      if (!keys.current.has(token))
        keys.current.set(token, crypto.randomUUID());
      const v = await send({
        action: "submitted",
        job_id: job.id,
        version: job.application_version,
        key: keys.current.get(token),
      });
      setUndo({ id: job.id, version: v.version });
      setNotice("已标记为已投递");
      await load();
    } catch (e) {
      await load();
      setError((e as Error).message);
    } finally {
      mutation.current = false;
      setSaving(false);
    }
  }
  async function undoSubmission(target: UndoTarget) {
    if (mutation.current) return;
    mutation.current = true;
    setSaving(true);
    setError("");
    try {
      const token = "undo:" + target.id + ":" + target.version;
      if (!keys.current.has(token))
        keys.current.set(token, crypto.randomUUID());
      await send({
        action: "undo_submitted",
        job_id: target.id,
        version: target.version,
        key: keys.current.get(token),
      });
      setUndo(null);
      setNotice("已撤销投递标记");
      await load();
    } catch (e) {
      await load();
      setError((e as Error).message);
    } finally {
      mutation.current = false;
      setSaving(false);
    }
  }
  async function confirm() {
    if (!action || !detail.trim()) return;
    setSaving(true);
    try {
      await send(review(action.job, "trash", detail.trim()));
      setAction(null);
      setNotice("已标记删除，可在回收站恢复");
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const stale = data?.source_health.some((s) => s.stale);
  useEffect(() => { if (data) onTotal?.(data.total); }, [data, onTotal]);
  return (
    <section aria-label={trash ? "回收站" : "岗位列表"}>
      {
        <>
          {!trash && <ExtensionSync onSynced={load} />}
          <ListToolbar
            navigation={navigation}
            totals={<span title={stale ? "部分来源待更新" : busy ? "正在更新" : undefined}><ApplicationTotals key={kind} kind={kind}/></span>}
            filters={!trash && <>
              <Button size="sm" variant="secondary" aria-pressed={!!filters.region} onPress={() => toggleRegion(!filters.region)}>地区</Button>
              <Button size="sm" variant="secondary" aria-pressed={filters[companyKey] === "1"} onPress={() => filter(companyKey, filters[companyKey] === "1" ? "" : "1")}>公司</Button>
            </>}
            date={!trash && <DateWindowFilter value={filters.added_date} onChange={v => filter("added_date", v)}/>}
            query={query} onQuery={setQuery}
            menu={trash ? [{ id: "retention", label: "删除记录保留 24 小时供恢复", disabled: true, onAction: () => {} }] : [{ id: "exclude", label: `排除公司${filters.exclude_companies ? `（${splitCompanies(filters.exclude_companies).length}）` : ""}`, onAction: () => { setExcludedCompanies(filters.exclude_companies); setExclusionsOpen(true); } }]}
          />
          {!data && !error && <p className="text-muted">正在读取岗位…</p>}
          {data?.jobs.length === 0 && (
            <div className="px-3 py-18 text-center text-muted">
              {trash ? "回收站暂无岗位" : "当前筛选下没有岗位"}
            </div>
          )}
          {!!data?.jobs.length && (
            <JobTable
              data={data}
              trash={trash}
              kind={kind}
              saving={saving}
              restore={restore}
              submission={submission}
              undoSubmission={undoSubmission}
              open={open}
            />
          )}

          <ListPagination page={filters.page} pages={Math.max(1, Math.ceil((data?.total || 0) / 50))} busy={busy} onPage={page => setFilters(f => ({ ...f, page }))}/>

        </>
      }
      {error && (
        <p role="alert" className="py-4 text-danger">
          {error}
        </p>
      )}
      {notice && (
        <Alert
          className="fixed bottom-6 left-4 right-4 z-50 mx-auto max-w-xl"
          role="status"
        >
          <Alert.Content>
            <Alert.Description>{notice}</Alert.Description>
          </Alert.Content>
          {undo && (
            <Button
              size="sm"
              variant="secondary"
              isDisabled={saving}
              onPress={() => undoSubmission(undo)}
            >
              撤销
            </Button>
          )}
        </Alert>
      )}
      <Modal.Backdrop isOpen={exclusionsOpen} onOpenChange={setExclusionsOpen}>
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-sm">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>排除公司</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <TextField
                value={excludedCompanies}
                onChange={setExcludedCompanies}
              >
                <Label>公司名称</Label>
                <Input placeholder="例如 TikTok, Amazon" variant="secondary" />
              </TextField>
              <p className="mt-2 text-xs text-muted">多家公司用逗号分隔。</p>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => setExcludedCompanies("")}>
                清空
              </Button>
              <Button
                variant="secondary"
                onPress={() => setExclusionsOpen(false)}
              >
                取消
              </Button>
              <Button
                onPress={() => {
                  filter(
                    "exclude_companies",
                    splitCompanies(excludedCompanies).join(", "),
                  );
                  setExclusionsOpen(false);
                }}
              >
                保存
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
      <Modal.Backdrop
        isOpen={!!action}
        onOpenChange={(open) => {
          if (!open && !saving) setAction(null);
        }}
      >
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-md">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>删除岗位</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <p className="mb-4">
                {action?.job.company} · {action?.job.title}
              </p>
              <TextField isRequired value={detail} onChange={setDetail}>
                <Label>删除原因</Label>
                <TextArea variant="secondary" autoFocus />
              </TextField>
              <p className="mt-3 text-sm text-muted">
                添加“已删除”标签并隐藏，可在回收站恢复。以后同步不会带回。
              </p>
              {actionError && (
                <p className="mt-3 text-danger" role="alert">
                  {actionError}
                </p>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="secondary"
                isDisabled={saving}
                onPress={() => setAction(null)}
              >
                取消
              </Button>
              <Button
                variant={action?.type === "trash" ? "danger-soft" : "primary"}
                isDisabled={!detail.trim() || saving}
                isPending={saving}
                onPress={confirm}
              >
                确认
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </section>
  );
}
createRoot(document.getElementById("root")!).render(
  <SiteApp Board={JobsBoard} />,
);
