import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SiteApp } from "./SiteApp";
import type { BoardProps } from "./JobWorkspace";
import { CLIENT_PROTOCOL_HEADERS } from "./client-protocol";
import {
  Alert,
  Card,
  Button,
  Chip,
  Input,
  Label,
  ListBox,
  Select as HeroSelect,
  Modal,
  Table,
  TextArea,
  TextField,
} from "@heroui/react";
import { Segment } from "@heroui-pro/react";
import "./style.css";
import { ExtensionSync } from "./ExtensionSync";
import { createBoardLoader } from "./board-loader";
import { DateWindowFilter } from "./DateWindowFilter";
import { addedRange, normalizeDateWindow, rangeLabel } from "./date-window";

import { JobTable } from "./JobTable";
import { Select } from "./BoardSelect";
import {
  api,
  date,
  safe,
  statusColor,
  names,
  screenings,
  statusOptions,
  displayFilterStatus,
  defaults,
  filterKey,
  splitCompanies,
  type Job,
  type Recent,
  type UndoTarget,
  type Listing,
  type Counts,
  type Filters,
  type Kind,
} from "./job-board-model";
export function JobsBoard({ kind, trash }: BoardProps) {
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const auth = true;
  const [data, setData] = useState<Listing | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [advanced, setAdvanced] = useState(false),
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
    try {
      const saved = localStorage.getItem(filterKey);
      if (saved) {
        const prior = JSON.parse(saved),
          f = { ...defaults, ...prior, page: 1 };
        return {
          ...f,
          added_date: normalizeDateWindow(f.added_date),
          roles: "",
          exclude_data_engineering: "",
          exclude_titles: "",
          status: displayFilterStatus(f.status),
        };
      }
      const raw =
        localStorage.getItem("radar-filters-shared-v5") ||
        localStorage.getItem("radar-filters-shared-v4") ||
        localStorage.getItem("radar-filters-shared-v3");
      if (!raw) return defaults;
      const { compact, intern_companies, ...old } = JSON.parse(raw);
      // Preserve deliberate search, exclusion and region preferences; the new
      // employer switches are independent and remembered per employment kind.
      return {
        ...defaults,
        ...old,
        company_newgrad: "",
        company_internship: "1",
        region: old.region || (compact === false ? "" : "focus_remote"),
        added_date: normalizeDateWindow(old.added_date),
        roles: "",
        exclude_data_engineering: "",
        exclude_titles: "",
        status: displayFilterStatus(old.status),
        page: 1,
      };
    } catch {
      return defaults;
    }
  });
  const [draft, setDraft] = useState<Filters | null>(null);
  const [countsUnavailable, setCountsUnavailable] = useState(false);
  const [counts, setCounts] = useState<Counts | null>(null),
    [preview, setPreview] = useState<Counts | null>(null),
    [previewError, setPreviewError] = useState("");
  const [query, setQuery] = useState(filters.text),
    [action, setAction] = useState<{ type: "trash"; job: Job } | null>(null),
    [detail, setDetail] = useState(""),
    [actionError, setActionError] = useState(""),
    [saving, setSaving] = useState(false);
  const [undo, setUndo] = useState<UndoTarget[] | null>(null),
    [showRecent, setShowRecent] = useState(false),
    [batchProgress, setBatchProgress] = useState("");
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
    setCounts(null);
    setCountsUnavailable(false);
    const { added_date, ...rest } = filters;
    const params = new URLSearchParams({
      ...rest,
      ...addedRange(trash ? "" : added_date),
      page: String(filters.page),
      kind,
      view: trash ? "trash" : "jobs",
      page_size: "50",
      ...(trash ? { status: "", screening: "" } : {}),
    });
    try {
      const v = await loader.jobs(params);
      // Start secondary totals only after the primary list has returned.
      if (!trash && current()) {
        void loader.counts(params).then(
          (v) => {
            if (current()) setCounts(v);
          },
          () => {
            if (current()) {
              setCounts(null);
              setCountsUnavailable(true);
            }
          },
        );
      }
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
    if (!trash) localStorage.setItem(filterKey, JSON.stringify(filters));
  }, [filters]);
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
  useEffect(() => {
    if (!auth || !advanced || !draft || trash) return;
    let active = true;
    setPreview(null);
    setPreviewError("");
    const timer = setTimeout(() => {
      const { added_date, page, ...rest } = draft;
      void api(
        "/api/filter-counts?" +
          new URLSearchParams({ ...rest, ...addedRange(added_date) }),
      )
        .then((v) => {
          if (active) setPreview(v);
        })
        .catch((e) => {
          if (active) setPreviewError(e.message);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [auth, advanced, draft]);
  function draftFilter(key: keyof Filters, value: string) {
    setDraft((f) => (f ? { ...f, [key]: value } : f));
  }
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
    try {
      return await api("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } finally {
      loader.invalidate();
    }
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
  async function trackOpened(job: Recent, dismiss = false) {
    try {
      await send({ action: "opened", job_id: job.id, kind, dismiss });
      await load();
    } catch (e) {
      setError("打开记录未保存：" + (e as Error).message);
    }
  }
  async function submission(input: Recent | Recent[]) {
    if (mutation.current) return;
    mutation.current = true;
    setSaving(true);
    const jobs = Array.isArray(input) ? [...input] : [input],
      completed: UndoTarget[] = [],
      failures: string[] = [];
    setError("");
    try {
      for (const [index, job] of jobs.entries()) {
        if (jobs.length > 1) setBatchProgress(`${index + 1} / ${jobs.length}`);
        const token = "submitted:" + job.id + ":" + job.application_version;
        if (!keys.current.has(token))
          keys.current.set(token, crypto.randomUUID());
        try {
          const v = await send({
            action: "submitted",
            job_id: job.id,
            version: job.application_version,
            key: keys.current.get(token),
          });
          completed.push({ id: job.id, version: v.version });
        } catch (e) {
          failures.push(`${job.company}：${(e as Error).message}`);
        }
      }
      if (completed.length) {
        setUndo(completed);
        setNotice(
          `已标记 ${completed.length} 个岗位为已投递${failures.length ? `，${failures.length} 个未确认成功` : ""}`,
        );
      }
      await load();
      if (failures.length)
        setError(
          `${failures.length} 个岗位未确认标记成功，请查看刷新后的状态。${failures[0]}`,
        );
    } finally {
      mutation.current = false;
      setSaving(false);
      setBatchProgress("");
    }
  }
  async function undoSubmission(input: UndoTarget | UndoTarget[]) {
    if (mutation.current) return;
    mutation.current = true;
    setSaving(true);
    const targets = Array.isArray(input) ? input : [input],
      remaining: UndoTarget[] = [];
    let failure = "";
    setError("");
    try {
      for (const target of targets) {
        const token = "undo:" + target.id + ":" + target.version;
        if (!keys.current.has(token))
          keys.current.set(token, crypto.randomUUID());
        try {
          await send({
            action: "undo_submitted",
            job_id: target.id,
            version: target.version,
            key: keys.current.get(token),
          });
        } catch (e) {
          remaining.push(target);
          failure = (e as Error).message;
        }
      }
      setUndo(remaining.length ? remaining : null);
      setNotice(
        `已撤销 ${targets.length - remaining.length} 个岗位的标记${remaining.length ? `，${remaining.length} 个未确认成功` : ""}`,
      );
      await load();
      if (remaining.length) setError(failure);
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
  const stale = data?.source_health.some((s) => s.stale),
    synced = data?.source_health.length
      ? Math.min(...data.source_health.map((s) => s.last_success || 0))
      : 0;

  const countText = (c: Counts) =>
    `全职 ${c.newgrad.total} + 实习 ${c.internship.total} = ${c.total} 个`;
  const unstarted = (c: Counts) =>
    c.newgrad.total -
    c.newgrad.submitted +
    (c.internship.total - c.internship.submitted);
  return (
    <section aria-label={trash ? "回收站" : "岗位列表"}>
      {
        <>
          {!trash && <ExtensionSync onSynced={load} />}
          {!trash && !!data?.recent_opened.length && (
            <Card className="mb-5" aria-label="刚打开的岗位">
              <Card.Content className="gap-3">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <h2>刚打开 · {data.recent_opened.length}</h2>
                  <span className="text-muted">
                    自动同步未覆盖的岗位，可在此手动确认
                  </span>
                  <Button
                    className="sm:ml-auto"
                    size="sm"
                    variant="secondary"
                    isDisabled={saving || busy}
                    isPending={!!batchProgress}
                    onPress={() => submission(data.recent_opened)}
                  >
                    {batchProgress
                      ? `正在标记 ${batchProgress}`
                      : `全部标记已投递（${data.recent_opened.length}）`}
                  </Button>
                </div>
                {(showRecent
                  ? data.recent_opened
                  : data.recent_opened.slice(0, 3)
                ).map((job) => (
                  <div
                    className="flex flex-wrap items-center justify-between gap-3 py-2"
                    key={job.id}
                  >
                    <div>
                      <strong>{job.company}</strong>
                      <span className="text-muted">{job.title}</span>
                    </div>
                    <div className="flex items-center gap-1.5 whitespace-nowrap">
                      <Button
                        size="sm"
                        variant="secondary"
                        isDisabled={saving}
                        onPress={() => submission(job)}
                      >
                        标记已投递
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        isDisabled={saving}
                        onPress={() => trackOpened(job, true)}
                      >
                        暂不处理
                      </Button>
                    </div>
                  </div>
                ))}
                {data.recent_opened.length > 3 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() => setShowRecent((v) => !v)}
                  >
                    {showRecent
                      ? "收起"
                      : "展开其余 " + (data.recent_opened.length - 3) + " 个"}
                  </Button>
                )}
              </Card.Content>
            </Card>
          )}
          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:flex-wrap">
            {!trash && (
              <section
                className="flex flex-wrap items-center gap-2"
                aria-label="收录日期筛选"
              >
                <DateWindowFilter
                  value={filters.added_date}
                  onChange={(v) => filter("added_date", v)}
                />
              </section>
            )}
            <section
              className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
              aria-label="岗位筛选"
            >
              <TextField
                aria-label="搜索公司或岗位"
                value={query}
                onChange={setQuery}
                className="min-w-48 flex-1 basis-full sm:basis-auto"
              >
                <Input placeholder="搜索公司或岗位" variant="secondary" />
              </TextField>
              {!trash && (
                <div className="w-44">
                  <Select
                    label="投递状态"
                    value={filters.status}
                    options={statusOptions}
                    onChange={(v) => filter("status", v)}
                  />
                </div>
              )}
              {!trash && (
                <div className="flex shrink-0 items-center gap-4">
                  <Button
                    size="sm"
                    variant={filters.region ? "secondary" : "ghost"}
                    aria-pressed={!!filters.region}
                    onPress={() => toggleRegion(!filters.region)}
                  >
                    地区筛选
                  </Button>
                  <Button
                    size="sm"
                    variant={
                      filters[companyKey] === "1" ? "secondary" : "ghost"
                    }
                    aria-pressed={filters[companyKey] === "1"}
                    onPress={() =>
                      filter(companyKey, filters[companyKey] === "1" ? "" : "1")
                    }
                  >
                    公司筛选
                  </Button>
                  <Button
                    variant="secondary"
                    onPress={() => {
                      setDraft({ ...filters });
                      setAdvanced(true);
                    }}
                    aria-haspopup="dialog"
                  >
                    筛选设置
                  </Button>
                </div>
              )}
            </section>
          </div>
          {!trash && !!filters.region && (
            <p className="text-xs leading-relaxed text-muted mt-2">
              {filters.region === "focus_remote"
                ? "地区：CA、WA、NY、MA、TX、美国远程及地点待定；FAANG+ 或精选公司在美国境内不限州。"
                : filters.region === "ca"
                  ? "地区：仅加州，不使用公司豁免。"
                  : "地区：加州和美国远程，不使用公司豁免。"}
            </p>
          )}
          {!trash && filters[companyKey] === "1" && (
            <p className="text-xs leading-relaxed text-muted mt-2">
              公司：只显示精选通过的岗位，全职和实习使用同一标准。尚未评估的岗位关闭此开关可见。
            </p>
          )}
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

          {countsUnavailable && (
            <p role="status" className="text-warning text-sm">
              岗位数量暂时不可用
            </p>
          )}
          <div className="my-4 flex flex-wrap items-center gap-3">
            <h1>
              {trash ? "回收站" : kind === "newgrad" ? "全职" : "实习"}{" "}
              <span className="text-muted">
                {data?.total.toLocaleString() ?? "—"}
              </span>
            </h1>
            {!trash && data && (
              <div
                className="flex flex-wrap gap-3 text-xs tabular-nums text-muted"
                aria-label="当前筛选投递进度"
              >
                <span className="count-submitted">
                  已投递 {data.application_counts.submitted}
                </span>
                <span className="count-unstarted">
                  未投递 {data.total - data.application_counts.submitted}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2 text-xs sm:ml-auto">
              {!trash && (
                <span className="text-muted">
                  {rangeLabel(filters.added_date) + " · 每分钟更新"}
                </span>
              )}
              <span className={stale ? "text-warning" : "text-muted"}>
                {busy ? "正在更新…" : stale ? "部分来源待更新" : ""}
              </span>
              <Button
                size="sm"
                variant="ghost"
                isDisabled={busy}
                onPress={() => {
                  loader.invalidate();
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
              trackOpened={trackOpened}
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
              {undo.length > 1 ? "全部撤销" : "撤销"}
            </Button>
          )}
        </Alert>
      )}
      <Modal.Backdrop isOpen={advanced} onOpenChange={setAdvanced}>
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-lg">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>筛选</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="space-y-4">
              {draft && (
                <>
                  {!trash && (
                    <Select
                      label="来源标记"
                      value={draft.group}
                      options={{
                        "": "全部公司",
                        faang: "来源标记 FAANG+",
                        other: "无 FAANG+ 标记",
                      }}
                      onChange={(v) => draftFilter("group", v)}
                    />
                  )}
                  <section aria-label="排除公司">
                    <TextField
                      value={draft.exclude_companies}
                      onChange={(v) => draftFilter("exclude_companies", v)}
                    >
                      <Label>排除公司</Label>
                      <Input
                        placeholder="例如 TikTok, Amazon"
                        variant="secondary"
                      />
                    </TextField>
                    <p className="text-xs leading-relaxed text-muted mt-2">
                      按完整公司名称匹配，不区分大小写；多家公司用逗号分隔。仅隐藏列表，不删除岗位。
                    </p>
                  </section>
                  <section aria-label="地区范围">
                    <p className="mb-1.5 text-sm">地区范围</p>
                    <Select
                      label="地域范围"
                      value={draft.region}
                      options={{
                        "": "全部地区",
                        focus_remote: "重点地区 + 美国远程",
                        ca_remote: "加州 + 美国远程",
                        ca: "仅加州",
                      }}
                      onChange={(v) => draftFilter("region", v)}
                    />
                    {draft.region === "focus_remote" && (
                      <p className="text-xs leading-relaxed text-muted mt-2">
                        CA、WA、NY、MA、TX、美国远程及地点待定；FAANG+
                        或精选公司在美国境内不限州。
                      </p>
                    )}
                  </section>
                  {!trash && (
                    <div
                      className="flex flex-col gap-1 text-sm tabular-nums"
                      role="status"
                      aria-live="polite"
                    >
                      {previewError ? (
                        <span className="text-danger">
                          数量读取失败，请重新选择或稍后重试
                        </span>
                      ) : preview ? (
                        <>
                          <strong>{countText(preview)}</strong>
                          <span className="text-muted">
                            其中未投递 {unstarted(preview)} 个 ·{" "}
                            {rangeLabel(draft.added_date)}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted">正在计算…</span>
                      )}
                    </div>
                  )}
                  <p className="text-xs leading-relaxed text-muted">
                    只调整显示，不删除岗位。
                  </p>
                </>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="ghost"
                onPress={() => {
                  setDraft((f) =>
                    f
                      ? {
                          ...f,
                          exclude_companies: "",
                          roles: "",
                          region: "",
                          [companyKey]: "",
                        }
                      : f,
                  );
                }}
              >
                全部显示
              </Button>
              <Button variant="secondary" onPress={() => setAdvanced(false)}>
                取消
              </Button>
              <Button
                onPress={() => {
                  if (draft) setFilters({ ...draft, page: 1 });
                  setAdvanced(false);
                }}
              >
                保存并应用
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
