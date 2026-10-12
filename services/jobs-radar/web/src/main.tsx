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
import {
  api,
  defaults,
  splitCompanies,
  type Job,
  type UndoTarget,
  type Listing,
  type Filters,
} from "./job-board-model";
export function JobsBoard({ kind, trash, navigation, query, setQuery }: BoardProps) {
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
        status: "",
      };
    return { ...readBoardFilters(localStorage, kind), text: query };
  });
  const [excludedCompanies, setExcludedCompanies] = useState("");
  const [action, setAction] = useState<{ type: "trash"; job: Job } | null>(null),
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
      ...(trash ? { status: "" } : {}),
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
  }, [filters, kind, loader]);
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
  return (
    <section aria-label={trash ? "回收站" : "岗位列表"}>
      {
        <>
          {!trash && <ExtensionSync onSynced={load} />}
          <div className="board-toolbar">
            <section className="board-toolbar-scoped" aria-label="类型与岗位筛选">
              {navigation}
              {!trash && <div className="flex items-center gap-2">
                <Button size="sm" variant={filters.region ? "secondary" : "ghost"}
                  aria-pressed={!!filters.region} onPress={() => toggleRegion(!filters.region)}>
                  地区筛选
                </Button>
                <Button size="sm" variant={filters[companyKey] === "1" ? "secondary" : "ghost"}
                  aria-pressed={filters[companyKey] === "1"}
                  onPress={() => filter(companyKey, filters[companyKey] === "1" ? "" : "1")}>
                  公司筛选
                </Button>
              </div>}
            </section>
            <section className="board-toolbar-shared" aria-label="通用筛选">
              {!trash && <DateWindowFilter value={filters.added_date} onChange={(v) => filter("added_date", v)} />}
              <TextField aria-label="搜索公司或岗位" value={query} onChange={setQuery} className="board-search">
                <Input placeholder="搜索公司或岗位" variant="secondary" />
              </TextField>
              {!trash && <>
                <Button size="sm" variant={filters.status === "unsubmitted" ? "secondary" : "ghost"}
                  aria-pressed={filters.status === "unsubmitted"}
                  onPress={() => filter("status", filters.status === "unsubmitted" ? "recent" : "unsubmitted")}>
                  仅看未投递
                </Button>
                <Button size="sm" variant="ghost" aria-haspopup="dialog" onPress={() => {
                  setExcludedCompanies(filters.exclude_companies);
                  setExclusionsOpen(true);
                }}>排除公司</Button>
              </>}
            </section>
          </div>
          {!trash && !!filters.exclude_companies && (
            <div
              className="excluded-companies flex gap-2 flex-wrap mt-2"
              aria-label="已排除公司"
            >
              {splitCompanies(filters.exclude_companies).map((company) => (
                <Button
                  key={company}
                  size="sm"
                  variant="secondary"
                  aria-label={"取消排除 " + company}
                  onPress={() =>
                    filter(
                      "exclude_companies",
                      splitCompanies(filters.exclude_companies)
                        .filter((v) => v !== company)
                        .join(", "),
                    )
                  }
                >
                  已排除 {company} ×
                </Button>
              ))}
            </div>
          )}

          <div className="my-4 flex flex-wrap items-center gap-3">
            <h1>
              {trash ? "回收站" : kind === "newgrad" ? "全职" : "实习"}{" "}
              <span className="text-muted">
                {data?.total.toLocaleString() ?? "—"}
              </span>
            </h1>
            <div className="flex flex-wrap items-center gap-3 text-xs sm:ml-auto">
              <ApplicationTotals key={kind} kind={kind} />
              <span className={stale ? "text-warning" : "text-muted"}>
                {busy ? "正在更新…" : stale ? "部分来源待更新" : ""}
              </span>
              <Button
                size="sm"
                variant="ghost"
                isDisabled={busy}
                onPress={() => {
                  void load();
                }}
              >
                刷新
              </Button>
            </div>
          </div>
          {trash && (
            <p className="mb-5 text-sm text-muted">
              保留 24
              小时供恢复；到期后“已删除”标签仍有效，同步不会带回。恢复后人工保留。
            </p>
          )}
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
              filters={filters}
              saving={saving}
              restore={restore}
              submission={submission}
              undoSubmission={undoSubmission}
              open={open}
            />
          )}

          <footer className="flex flex-wrap items-center gap-2 pt-3 text-xs">
            <span className="text-muted">
              第 {filters.page} /{" "}
              {Math.max(1, Math.ceil((data?.total || 0) / 50))} 页
            </span>
            <Button
              size="sm"
              variant="ghost"
              isDisabled={filters.page === 1 || busy}
              onPress={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}
            >
              上一页
            </Button>
            <Button
              size="sm"
              variant="ghost"
              isDisabled={filters.page * 50 >= (data?.total || 0) || busy}
              onPress={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}
            >
              下一页
            </Button>
            <Button
              size="sm"
              className="ml-auto"
              variant="ghost"
              onPress={async () => {
                await api("/api/session", { method: "DELETE" });
                location.reload();
              }}
            >
              退出
            </Button>
          </footer>
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
              variant="ghost"
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
              <Button variant="ghost" onPress={() => setExcludedCompanies("")}>
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
                variant="ghost"
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
