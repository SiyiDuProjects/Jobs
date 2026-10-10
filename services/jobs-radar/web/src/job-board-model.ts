import { CLIENT_PROTOCOL_HEADERS } from "./client-protocol";
export type Evidence = { url: string; quote: string; observed_at: string };
export type Job = {
  progress?: {
    stage: string;
    received_at: number;
    summary: string;
    email_url: string;
  } | null;
  role_family: string;
  role_basis: string;
  id: string;
  group: string;
  company: string;
  title: string;
  locations: string[];
  sources: string[];
  apply_url: string | null;
  source_url: string | null;
  posted_at: number | null;
  added_at: number;
  status: string;
  opened_at: number | null;
  can_undo_submission: boolean;
  active: boolean;
  application_version: number;
  review_version: number;
  fingerprint: string;
  screening: string;
  review: null | {
    detail: string;
    manual_keep: number;
    expires_at: number;
    evidence: Evidence[];
  };
};
export type Recent = Pick<
  Job,
  "id" | "company" | "title" | "application_version"
>;
export type UndoTarget = { id: string; version: number };
export type Listing = {
  groups: Record<string, number>;
  jobs: Job[];
  recent_opened: Recent[];
  application_counts: Record<string, number>;
  total: number;
  source_health: { last_success: number; stale: boolean }[];
};
export type Counts = {
  newgrad: { total: number; submitted: number };
  internship: { total: number; submitted: number };
  total: number;
};
export type Filters = {
  exclude_companies: string;
  company_newgrad: string;
  company_internship: string;
  roles: string;
  exclude_data_engineering: string;
  exclude_titles: string;
  region: string;
  text: string;
  location: string;
  category: string;
  status: string;
  group: string;
  screening: string;
  added_date: string;
  page: number;
};
export const statusOptions = {
  recent: "全部岗位",
  unsubmitted: "未投递",
  submitted: "已投递",
};
export const displayFilterStatus = (status: string) =>
  status === "submitted" ||
  [
    "received",
    "assessment",
    "interview",
    "offer",
    "rejected",
    "withdrawn",
  ].includes(status)
    ? "submitted"
    : [
          "unsubmitted",
          "not_started",
          "needs_input",
          "skipped",
          "retryable_failure",
          "in_progress",
          "submitted_unconfirmed",
        ].includes(status)
      ? "unsubmitted"
      : "recent";
export const names: Record<string, string> = {
  simplify: "Simplify",
  speedyapply: "SpeedyApply",
  jobright: "Jobright",
};
export const screenings: Record<string, string> = {
  pending: "待初筛",
  keep: "已保留",
  review: "待核实",
  trash: "已删除",
};
export type Kind = "newgrad" | "internship";

export const splitCompanies = (value: string) =>
  Array.from(
    new Map(
      value
        .split(/[,，;；\n]/)
        .map((v) => v.trim())
        .filter(Boolean)
        .map((v) => [v.normalize("NFKC").toLowerCase(), v]),
    ).values(),
  );
export const defaults: Filters = {
  exclude_companies: "",
  company_newgrad: "",
  company_internship: "1",
  roles: "",
  exclude_data_engineering: "",
  exclude_titles: "",
  region: "focus_remote",
  text: "",
  location: "",
  category: "",
  status: "recent",
  group: "",
  screening: "",
  added_date: "",
  page: 1,
};
export const filterKey = "radar-filters-shared-v7";
export const statusColor = (job: Job) =>
  job.status === "submitted" ? "success" : "default";
export const safe = (url: string | null) => {
  try {
    const u = new URL(url || "");
    return ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
};
export const date = (ts: number | null) =>
  ts
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
      }).format(ts * 1000)
    : "—";
export async function api(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  for (const [name, value] of Object.entries(CLIENT_PROTOCOL_HEADERS))
    headers.set(name, value);
  const r = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers,
  });
  let v;
  try {
    v = await r.json();
  } catch {
    throw new Error("暂时无法连接，请刷新重试");
  }
  if (!r.ok)
    throw new Error(
      r.status === 401
        ? "登录已过期，请刷新页面重新连接"
        : v.error || "操作失败",
    );
  return v;
}
