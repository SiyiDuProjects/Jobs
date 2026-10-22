import { useState } from "react";

// Only list controls belong here. Profile drafts and answers stay out of storage.
export type AppliedPreferences = {
  query: string;
  status: string;
  from: string;
  to: string;
  page: number;
  unclassified: boolean;
};
const defaults: AppliedPreferences = {
  query: "",
  status: "all",
  from: "",
  to: "",
  page: 1,
  unclassified: false,
};
export function readAppliedPreferences(
  storage: Pick<Storage, "getItem">,
  kind: string,
): AppliedPreferences {
  try {
    const value = JSON.parse(
      storage.getItem(`jobs:view:applied:${kind}`) || "null",
    );
    if (!value || typeof value !== "object") return { ...defaults };
    return {
      query: typeof value.query === "string" ? value.query : "",
      status: typeof value.status === "string" ? value.status : "all",
      from: /^\d{4}-\d{2}-\d{2}$/.test(value.from) ? value.from : "",
      to: /^\d{4}-\d{2}-\d{2}$/.test(value.to) ? value.to : "",
      page: Number.isSafeInteger(value.page) && value.page > 0 ? value.page : 1,
      unclassified: value.unclassified === true,
    };
  } catch {
    return { ...defaults };
  }
}
export function useAppliedPreferences(kind: string) {
  const [value, setValue] = useState(() =>
    readAppliedPreferences(sessionStorage, kind),
  );
  const update = (patch: Partial<AppliedPreferences>) =>
    setValue((current) => {
      const next = { ...current, ...patch };
      try {
        sessionStorage.setItem(
          `jobs:view:applied:${kind}`,
          JSON.stringify(next),
        );
      } catch {
        /* Storage may be unavailable. Controls still work. */
      }
      return next;
    });
  return [value, update] as const;
}

export function readBoardPosition(
  kind: string,
  view: string,
): { query: string; page: number } {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(`jobs:view:${view}:${kind}`) || "null",
    );
    return {
      query: typeof value?.query === "string" ? value.query : "",
      page:
        Number.isSafeInteger(value?.page) && value.page > 0 ? value.page : 1,
    };
  } catch {
    return { query: "", page: 1 };
  }
}
export function saveBoardPosition(
  kind: string,
  view: string,
  query: string,
  page: number,
) {
  try {
    sessionStorage.setItem(
      `jobs:view:${view}:${kind}`,
      JSON.stringify({ query, page }),
    );
  } catch {
    /* Browsing also works without session storage. */
  }
}
