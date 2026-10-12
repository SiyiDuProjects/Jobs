import { defaults, filterKey, splitCompanies, type Filters, type Kind } from "./job-board-model";
import { normalizeDateWindow } from "./date-window";

export const sharedFilterKey = "radar-filters-shared-v9";
export const kindFilterKey = (kind: Kind) => `radar-filters-kind-v9:${kind}`;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function read(storage: Storage, key: string): Partial<Filters> | undefined {
  try {
    const value = JSON.parse(storage.getItem(key) || "null");
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function scoped(prior: Partial<Filters> & { compact?: boolean }, kind: Kind) {
  const companyKey = kind === "newgrad" ? "company_newgrad" : "company_internship";
  return {
    region: ["", "ca", "ca_remote", "focus_remote"].includes(prior.region ?? "invalid")
      ? prior.region! : prior.compact === false ? "" : defaults.region,
    [companyKey]: ["", "1"].includes(prior[companyKey] ?? "invalid")
      ? prior[companyKey] : defaults[companyKey],
  };
}

function shared(prior: Partial<Filters>) {
  return {
    added_date: normalizeDateWindow(prior.added_date),
    status: prior.status === undefined || ["unsubmitted", "not_started", "needs_input", "skipped", "retryable_failure", "in_progress", "submitted_unconfirmed"].includes(prior.status)
      ? "unsubmitted" : "recent",
    exclude_companies: typeof prior.exclude_companies === "string" ? prior.exclude_companies : "",
  };
}

export function readBoardFilters(storage: Storage, kind: Kind): Filters {
  const legacy = [filterKey, "radar-filters-shared-v7", "radar-filters-shared-v5", "radar-filters-shared-v4", "radar-filters-shared-v3"]
    .map(key => read(storage, key)).find(Boolean) || {};
  const oldKind = read(storage, `${filterKey}:${kind}`);
  const otherKind = read(storage, `${filterKey}:${kind === "newgrad" ? "internship" : "newgrad"}`);
  let common = read(storage, sharedFilterKey);
  if (!common) {
    // A single shared date/status cannot retain conflicting active values. Prefer
    // the current kind, retain every exclusion, and leave all legacy keys intact.
    const prior = { ...legacy, ...otherKind, ...oldKind };
    const exclusions = [oldKind, otherKind].filter(Boolean);
    common = shared({
      ...prior,
      exclude_companies: splitCompanies((exclusions.length ? exclusions : [legacy])
        .map(value => value?.exclude_companies ?? legacy.exclude_companies ?? "").join(", ")).join(", "),
    });
    storage.setItem(sharedFilterKey, JSON.stringify(common));
  }
  return {
    ...defaults,
    ...scoped(read(storage, kindFilterKey(kind)) || { ...legacy, ...oldKind }, kind),
    ...shared(common),
    text: "",
    page: 1,
  };
}

export function saveBoardFilters(storage: Storage, kind: Kind, filters: Filters) {
  storage.setItem(kindFilterKey(kind), JSON.stringify(scoped(filters, kind)));
  storage.setItem(sharedFilterKey, JSON.stringify(shared(filters)));
}
