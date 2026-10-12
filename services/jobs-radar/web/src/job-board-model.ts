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
export type UndoTarget = { id: string; version: number };
export type Listing = {
  groups: Record<string, number>;
  jobs: Job[];
  application_counts: Record<string, number>;
  total: number;
  source_health: { last_success: number; stale: boolean }[];
};
export type Filters = {
  exclude_companies: string;
  company_newgrad: string;
  company_internship: string;
  region: string;
  text: string;
  added_date: string;
  page: number;
};
export const names: Record<string, string> = {
  simplify: "Simplify",
  speedyapply: "SpeedyApply",
  jobright: "Jobright",
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
  region: "focus_remote",
  text: "",
  added_date: "",
  page: 1,
};
export const filterKey = "radar-filters-shared-v8";
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
  if (path === "/api/actions" && options.method === "POST")
    window.dispatchEvent(new Event("jobs:applications-changed"));
  return v;
}
