import stageContract from "../../../jobs_radar/application-stages.json";
// Server contracts and behavior ported from the original management application.
// Presentation code does not load or patch the upstream extension bundles.
import { JobsProfileContract } from "./profile-contract.js";
import type { Profile } from "./profile-types";
export type { Profile, ApplicationDetails } from "./profile-types";
export type Application = {
  id?: string;
  version?: number;
  submission?: {
    attempted_at: number | null;
    confirmed_at: number | null;
    error: string | null;
    status: string;
  };
  jobTitle: string;
  jobLink: string;
  companyName: string;
  companyLink: string;
  date: string;
  status: string;
  profileName: string;
  progress?: ApplicationProgress;
};
export type ApplicationProgress = {
  application_id: string;
  stage: string;
  round: number | null;
  final: boolean;
  version: number;
  observed_at: number | null;
  source: string;
  summary: string;
  assessment_type?: "unknown" | "automatic" | "screened";
  display_stage?: string;
  ever_advanced?: boolean;
  label?: string;
  stage_label?: string;
  next_stages?: Record<string, string>;
  chart_path?: { stage: string; round?: number | null; final?: boolean }[];
  ended_from?: { stage: string; round: number | null; final: boolean } | null;
};
export type AppRow = Application & { key: string; boardStage?: string };
export type Response = {
  key: string;
  keywords: string[];
  response: string;
  appearances: number;
  fromAutofill: boolean;
  question?: string;
  id?: string;
};
export { questionKeywords } from "./saved-responses";
export type ProfileRecord = { id: string; profile: Profile; last_sync: string };
export type ProfileSummary = { id: string; profileName: string };
export type Documents = Record<string, { revision: number; value: any }>;
export const statuses: Record<string, string> = stageContract.statuses;
export const displayStatuses: Record<string, string> =
  stageContract.displayStatuses;
export function displayStage(row: Application): string {
  return row.progress?.display_stage || "no_answer";
}
export function progressLabel(row: Application): string {
  return row.progress?.label || "等待同步";
}
export function nextStages(row: Application): Record<string, string> {
  return row.progress?.next_stages || {};
}
export const blankJob = {
  jobTitle: "",
  company: "",
  location: "",
  startDate: "",
  currentlyWorkHere: false,
  description: "",
};
export const blankEducation = {
  school: "",
  degree: "",
  fieldOfStudy: "",
  startDate: "",
  endDate: "",
  currentlyAttending: false,
};
export const defaultProfile: Profile = {
  profileName: "Default",
  nameData: { firstName: "", lastName: "", preferredName: false },
  addressData: { line1: "", city: "", state: "", postalCode: "", country: "" },
  contactData: {
    phoneDeviceType: "",
    phoneCountryCode: "",
    phoneNumber: "",
    email: "",
  },
  jobData: [],
  educationData: [],
  languageData: [],
  resumeData: { resumeBase64: "", fileName: "", fileSize: 0, dateUploaded: "" },
  websiteData: { websites: [] },
  employmentData: { gender: "", ethnicity: "" },
  skillsData: [],
};
export const defaultSettings = {
  configName: "Default",
  autofillSettings: {
    saveApplications: true,
    autoClickNextPage: false,
    autoSubmit: false,
    saveResponses: true,
  },
};
const stable = (v: any): any =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, stable(v[k])]),
        )
      : v;
export const same = (a: any, b: any) =>
  JSON.stringify(stable(a)) === JSON.stringify(stable(b));
export const allowed = (key: string) =>
  [
    "boardCardOrder",
    "settings",
    "configList",
    "dailyGoal",
    "jobsKindProfiles",
  ].includes(key) || /^jobsResponses:[a-f0-9-]{36}$/i.test(key);
function indexed(list: any[], key: string) {
  const seen = new Map<string, number>();
  return new Map(
    (list || []).map((row) => {
      const id =
        key === "appliedList"
          ? row.id ||
            JSON.stringify([
              row.jobLink,
              row.jobTitle,
              row.companyName,
              row.date,
            ])
          : (row?.key ?? "invalid:" + JSON.stringify(stable(row)));
      const n = seen.get(id) || 0;
      seen.set(id, n + 1);
      return [id + "#" + n, row];
    }),
  );
}
export function merge(key: string, base: any, local: any, remote: any): any {
  if (same(local, base)) return remote;
  if (same(remote, base) || same(local, remote)) return local;
  if (remote === undefined) return local;
  if (local === undefined) return remote;
  if (key.startsWith("jobsResponses:")) {
    const a = indexed(base, key),
      b = indexed(local, key),
      c = indexed(remote, key),
      out = [];
    for (const id of new Set([...c.keys(), ...b.keys()])) {
      const before = a.get(id),
        left = b.get(id),
        right = c.get(id);
      if (same(left, before)) {
        if (right !== undefined) out.push(right);
      } else if (same(right, before) || same(left, right)) {
        if (left !== undefined) out.push(left);
      } else
        throw Error("同一条记录在两处修改；本地内容已保留，请核对后重试。");
    }
    return out;
  }
  if (base === undefined) return remote;
  throw Error("另一台设备已修改这项设置；本地内容已保留。");
}
export function appRows(rows: Application[]): AppRow[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const id = encodeURIComponent(
        [
          row.jobTitle,
          row.jobLink,
          row.companyLink,
          row.date,
          row.profileName,
        ].join("\0"),
      ),
      n = seen.get(id) || 0;
    seen.set(id, n + 1);
    return { ...row, key: row.id ?? `local:${n}:${id}` };
  });
}
export function changeApplication(
  rows: Application[],
  key: string,
  change: Partial<Application> | null,
) {
  const index = appRows(rows).findIndex((r) => r.key === key);
  if (index < 0) throw Error("This application is no longer stored");
  return rows.flatMap((r, i) =>
    i !== index ? [r] : change === null ? [] : [{ ...r, ...change }],
  );
}
export function safeHref(value: string) {
  try {
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol) ? u.href : undefined;
  } catch {
    return undefined;
  }
}
export const localDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
export function chartData(
  rows: Application[],
  from = "",
  to = "",
  now = new Date(),
) {
  const end = to
    ? new Date(to + "T00:00:00")
    : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  end.setDate(end.getDate() + 1);
  const start = from ? new Date(from + "T00:00:00") : new Date(end);
  if (!from) start.setDate(start.getDate() - 30);
  const days = (+end - +start) / 86400000,
    bucket = days > 730 ? "month" : days > 90 ? "week" : "day";
  const floor = (d: Date) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    if (bucket === "month") x.setDate(1);
    if (bucket === "week") x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
  };
  const values = new Map<string, number>();
  for (let d = floor(start), i = 0; d < end && i < 20000; i++) {
    values.set(localDay(d), 0);
    if (bucket === "month") d.setMonth(d.getMonth() + 1);
    else d.setDate(d.getDate() + (bucket === "week" ? 7 : 1));
  }
  for (const row of rows) {
    const d = new Date(row.date);
    if (d >= start && d < end) {
      const key = localDay(floor(d));
      values.set(key, (values.get(key) || 0) + 1);
    }
  }
  return {
    bucket,
    data: [...values].map(([date, count]) => ({ date, count })),
  };
}
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [],
    row: string[] = [];
  let value = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (c === "," || c === "\n")) {
      row.push(value.replace(/\r$/, ""));
      value = "";
      if (c === "\n") {
        if (row.some(Boolean)) rows.push([...row]);
        row.length = 0;
      }
    } else value += c;
  }
  if (quoted) throw Error("CSV contains an unclosed quoted field");
  row.push(value.replace(/\r$/, ""));
  if (row.some(Boolean)) rows.push(row);
  return rows;
}
export function exportCSV(rows: Application[]) {
  const fields = [
    "jobTitle",
    "jobLink",
    "companyName",
    "companyLink",
    "status",
    "date",
    "profileName",
  ] as const;
  const q = (v: string) => '"' + v.replaceAll('"', '""') + '"';
  return [
    fields.join(","),
    ...rows.map((r) => fields.map((k) => q(String(r[k] ?? ""))).join(",")),
  ].join("\r\n");
}
export function assertProfile(value: unknown): asserts value is Profile {
  JobsProfileContract.assertProfile(value);
}
