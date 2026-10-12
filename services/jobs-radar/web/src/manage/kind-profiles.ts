import type { JobKind } from "../JobWorkspace";
import type { ProfileSummary } from "./model";

export type KindProfiles = Partial<Record<"intern" | "newgrad", string>>;
export const profileKindKey = (kind: JobKind) =>
  kind === "internship" ? "intern" : "newgrad";
export const kindLabel = (kind: JobKind) =>
  kind === "internship" ? "实习" : "全职";

export function defaultKindProfiles(
  profiles: ProfileSummary[],
  saved: KindProfiles = {},
): KindProfiles {
  const bindings = { ...saved };
  for (const kind of ["newgrad", "internship"] as const) {
    const key = profileKindKey(kind);
    // Explicit bindings, including a deleted target, never fall through to a
    // different Profile. Only settings may replace an existing correspondence.
    if (bindings[key]) continue;
    const pattern =
      kind === "internship"
        ? /^(intern|internship|实习)$/i
        : /^(new[ -]?grad|ng|全职)$/i;
    const candidates = profiles.filter((p) =>
      pattern.test(p.profileName.trim()),
    );
    if (candidates.length === 1) bindings[key] = candidates[0].id;
  }
  return bindings;
}

export function profileForKind(
  kind: JobKind,
  profiles: ProfileSummary[],
  saved?: KindProfiles,
) {
  const id = defaultKindProfiles(profiles, saved)[profileKindKey(kind)];
  return profiles.some((p) => p.id === id) ? id : undefined;
}
