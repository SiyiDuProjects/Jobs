import { useSyncExternalStore } from "react";
import { CLIENT_PROTOCOL_HEADERS } from "../client-protocol";
import {
  allowed,
  assertProfile,
  merge,
  same,
  type Documents,
  type Profile,
  type ProfileRecord,
  type ProfileSummary,
  type Application,
} from "./model";
type State = {
  loading: boolean;
  applicationsLoading: boolean;
  draftDirty: boolean;
  authenticated: boolean;
  docs: Documents;
  profiles: ProfileSummary[];
  current?: ProfileRecord;
  pending: number;
  unsaved: number;
  error: string;
  notice: string;
};
export async function api(path: string, body?: unknown) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: { ...CLIENT_PROTOCOL_HEADERS, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || "Request failed");
  return value;
}
export class ManagementStore {
  state: State = {
    loading: true,
    applicationsLoading: false,
    draftDirty: false,
    authenticated: false,
    docs: {},
    profiles: [],
    pending: 0,
    unsaved: 0,
    error: "",
    notice: "",
  };
  private listeners = new Set<() => void>();
  private queue = Promise.resolve();
  private failed = new Map<
    string,
    { run: (check: () => void) => Promise<unknown>; error: string }
  >();
  private generation = 0;
  private profileRequest = 0;
  private lifecycle = 0;
  private applicationsVisible = true;
  private viewGeneration = 0;
  private timer?: ReturnType<typeof setInterval>;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  snapshot = () => this.state;
  private set(patch: Partial<State>) {
    if (patch.docs && !this.applicationsVisible) {
      const { appliedList, applicationProgressReview, ...docs } = patch.docs;
      patch = { ...patch, docs };
    }
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  report = (error: unknown) =>
    this.set({ error: error instanceof Error ? error.message : String(error) });
  setDraftDirty = (draftDirty: boolean) => this.set({ draftDirty });
  clearError = () => this.set({ error: "" });
  private statePath() {
    return this.applicationsVisible ? "/api/manage/state" : "/api/manage/state?applications=0";
  }
  private async readDocuments(): Promise<Documents> {
    const lifecycle = this.lifecycle;
    for (;;) {
      const view = this.viewGeneration;
      const docs = await api(this.statePath());
      if (view === this.viewGeneration || lifecycle !== this.lifecycle) return docs;
    }
  }
  setApplicationsVisible(visible: boolean) {
    if (visible === this.applicationsVisible) return;
    this.applicationsVisible = visible;
    this.viewGeneration++;
    this.generation++;
    const { appliedList, applicationProgressReview, ...docs } = this.state.docs;
    this.set({ docs, applicationsLoading: visible });
    if (this.state.authenticated) void this.refresh();
  }
  async start(existingSession?: { authenticated: boolean }, applicationsVisible = true) {
    clearInterval(this.timer);
    const lifecycle = ++this.lifecycle;
    this.applicationsVisible = applicationsVisible;
    this.viewGeneration++;
    this.set({ loading: true, applicationsLoading: applicationsVisible, error: "" });
    try {
      const session = existingSession || (await api("/api/session"));
      if (lifecycle !== this.lifecycle) return;
      if (!session.authenticated) {
        this.set({ loading: false });
        return;
      }
      this.set({ authenticated: true });
      const [, profiles] = await Promise.all([this.refresh(), this.profileAPI()]);
      if (lifecycle !== this.lifecycle) return;
      this.set({ profiles });
      const saved = sessionStorage.getItem("jobs:manage-profile"),
        id =
          profiles.find((p: ProfileSummary) => p.id === saved)?.id ||
          profiles[0]?.id;
      if (id) await this.selectProfile(id);
      if (lifecycle !== this.lifecycle) return;
      this.set({ loading: false, notice: "已连接 jobs" });
      this.timer = setInterval(() => {
        if (!document.hidden) void this.refresh();
      }, 15000);
    } catch (error) {
      if (lifecycle !== this.lifecycle) return;
      this.set({ loading: false, applicationsLoading: false });
      this.report(error);
    }
  }
  stop() {
    clearInterval(this.timer);
    this.lifecycle++;
    this.profileRequest++;
    this.failed.clear();
    this.queue = Promise.resolve();
    this.set({
      current: undefined,
      profiles: [],
      docs: {},
      applicationsLoading: false,
      authenticated: false,
      pending: 0,
      unsaved: 0,
      error: "",
      notice: "",
    });
  }
  async refresh() {
    if (this.state.pending) return;
    const version = this.generation;
    const lifecycle = this.lifecycle;
    try {
      const docs = await this.readDocuments();
      if (
        !this.state.pending &&
        lifecycle === this.lifecycle &&
        version === this.generation
      )
        this.set({ ...(!same(this.state.docs, docs) ? { docs } : {}), applicationsLoading: false });
    } catch (error) {
      if (lifecycle === this.lifecycle) {
        this.set({ applicationsLoading: false });
        this.report(error);
      }
    }
  }
  async profileAPI(suffix = "", method = "GET", body?: unknown) {
    const response = await fetch("/api/manage/profiles" + suffix, {
      method,
      credentials: "same-origin",
      headers: {
        ...CLIENT_PROTOCOL_HEADERS,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
      cache: "no-store",
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || "Profile request failed");
    return value;
  }
  async selectProfile(id: string) {
    if (this.state.pending) throw Error("请等待当前保存完成");
    if (this.state.unsaved) throw Error("仍有尚未保存的更改，请先重试保存");
    const request = ++this.profileRequest;
    const current = await this.profileAPI("/" + encodeURIComponent(id));
    if (request !== this.profileRequest) return;
    assertProfile(current.profile);
    this.set({ current });
    sessionStorage.setItem("jobs:manage-profile", current.id);
  }
  private failedError() {
    return this.failed.values().next().value?.error || "";
  }
  async retryFailed() {
    for (const [scope, value] of [...this.failed]) {
      if (this.failed.get(scope) === value) await this.task(scope, value.run);
    }
  }
  private task<T>(
    scope: string,
    fn: (check: () => void) => Promise<T>,
  ): Promise<T> {
    const lifecycle = this.lifecycle;
    const check = () => {
      if (lifecycle !== this.lifecycle) throw Error("当前编辑会话已结束");
    };
    this.generation++;
    this.set({
      pending: this.state.pending + 1,
      error: this.failedError(),
      notice: "正在保存…",
    });
    const task = this.queue.then(() => {
      check();
      return fn(check);
    });
    this.queue = task.then(
      () => {},
      () => {},
    );
    return task.then(
      (value) => {
        if (lifecycle !== this.lifecycle) return value;
        this.failed.delete(scope);
        this.set({
          pending: this.state.pending - 1,
          unsaved: this.failed.size,
          error: this.failedError(),
          notice: this.failed.size
            ? "部分更改尚未保存，请保留本页并重试"
            : "已保存到 jobs",
        });
        return value;
      },
      (error) => {
        // A disposed page releases every draft and ignores late completions.
        if (lifecycle !== this.lifecycle) return undefined as T;
        this.failed.set(scope, {
          run: fn,
          error: error instanceof Error ? error.message : String(error),
        });
        this.set({
          pending: this.state.pending - 1,
          unsaved: this.failed.size,
          error: this.failedError(),
          notice: "部分更改尚未保存，请保留本页并重试",
        });
        throw error;
      },
    );
  }
  write(
    values: Record<string, any>,
    base = Object.fromEntries(
      Object.keys(values).map((k) => [k, this.state.docs[k]?.value]),
    ),
  ) {
    const desired = structuredClone(values),
      baseline = structuredClone(base);
    return this.task(
      "documents:" + Object.keys(desired).sort().join(","),
      async (check) => {
        const remote: Documents = await this.readDocuments();
        check();
        const changes = Object.entries(desired)
          .map(([key, value]) => {
            if (!allowed(key)) throw Error("Unsupported management field");
            return {
              key,
              value: merge(key, baseline[key], value, remote[key]?.value),
              revision: remote[key]?.revision || 0,
            };
          })
          .filter((c) => !same(c.value, remote[c.key]?.value));
        const docs = changes.length
          ? await api(this.statePath(), { changes })
          : remote;
        check();
        this.set({ docs });
      },
    );
  }
  updateProgress(
    row: Application,
    values: Record<string, unknown>,
    key = crypto.randomUUID(),
  ) {
    return this.task("progress:" + row.id, async (check) => {
      if (!row.id || !row.progress) throw Error("请刷新后再更新申请进度");
      const result = await api("/api/manage/progress", {
        application_id: row.id,
        expected_version: row.progress.version,
        idempotency_key: key,
        ...values,
      });
      check();
      const docs = await this.readDocuments();
      check();
      this.set({ docs });
      if (typeof window !== "undefined") window.dispatchEvent(new Event("jobs:applications-changed"));
      return result;
    });
  }
  mutateApplications(
    changes: {
      action: "create" | "update" | "delete";
      application_id?: string;
      expected_version?: number;
      value?: Application;
    }[],
    key = crypto.randomUUID(),
  ) {
    const payload = structuredClone(changes);
    return this.task("applications:" + key, async (check) => {
      const result = await api("/api/manage/applications", {
        changes: payload,
        idempotency_key: key,
      });
      check();
      const docs = await this.readDocuments();
      check();
      this.set({ docs });
      if (typeof window !== "undefined") window.dispatchEvent(new Event("jobs:applications-changed"));
      return result;
    });
  }
  saveProfile(
    profile: Profile,
    record: ProfileRecord | null = this.state.current ?? null,
    createId = crypto.randomUUID(),
  ) {
    const value = JSON.parse(JSON.stringify(profile)) as Profile;
    const target = record
      ? { id: record.id, last_sync: record.last_sync }
      : null;
    const selection = this.profileRequest;
    assertProfile(value);
    return this.task("profile:" + (target?.id || createId), async (check) => {
      const result = await this.profileAPI(
        target ? "/" + encodeURIComponent(target.id) : "",
        target ? "PUT" : "POST",
        {
          ...(target ? { expected_sync: target.last_sync } : { id: createId }),
          profile: value,
        },
      );
      check();
      const current = { ...result, profile: value };
      const profiles: ProfileSummary[] = await this.profileAPI();
      check();
      if (
        selection === this.profileRequest &&
        (!target || this.state.current?.id === target.id)
      ) {
        this.set({ profiles, current });
        sessionStorage.setItem("jobs:manage-profile", current.id);
      } else this.set({ profiles });
      return current;
    });
  }
  deleteProfile(id: string) {
    let expected =
      this.state.current?.id === id ? this.state.current.last_sync : undefined;
    return this.task("profile:" + id, async (check) => {
      if (!expected)
        expected = (await this.profileAPI("/" + encodeURIComponent(id)))
          .last_sync;
      check();
      const current = await this.profileAPI(
        "/" + encodeURIComponent(id),
        "DELETE",
        {
          expected_sync: expected,
        },
      );
      check();
      const profiles = await this.profileAPI();
      check();
      if (this.state.current?.id === id || !this.state.current) {
        this.set({ profiles, current });
        sessionStorage.setItem("jobs:manage-profile", current.id);
      } else this.set({ profiles });
    });
  }
}
export const store = new ManagementStore();
export const useManagement = () =>
  useSyncExternalStore(store.subscribe, store.snapshot);
