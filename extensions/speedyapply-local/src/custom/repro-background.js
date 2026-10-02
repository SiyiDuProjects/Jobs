import { JobsReproCase } from "./repro-case.js";
import { JobsJobMatch } from "./job-match.js";
import { JobsDiagnosticHistory } from "./history-background.js";
import { publicJobUrl } from "./public-job-url.js";
let initialized = false;
export function initializeReproBackground() {
  if (initialized) return;
  initialized = true;
  const KEY = "jobsReproCasesV1",
    RETENTION = 30 * 86400000,
    MAX_BYTES = 10000000;
  let queue = Promise.resolve();
  /** @template T @param {() => T|PromiseLike<T>} fn @returns {Promise<T>} */
  const serial = (fn) => {
    const result = queue.then(fn);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const read = async () =>
    /** @type {import('./worker-types.js').ReproductionArchiveState} */ (
      (await chrome.storage.local.get(KEY))[KEY]
    ) || { applications: {} };
  const write = (state) => chrome.storage.local.set({ [KEY]: state });
  function prune(state) {
    for (const [key, item] of Object.entries(state.applications)) {
      item.cases = item.cases.filter(
        (row) => !row.resolvedAt || Date.now() - row.resolvedAt <= RETENTION,
      );
      if (!item.cases.length) delete state.applications[key];
    }
  }
  async function link(item, runId) {
    if (!item.url || !runId) return;
    const ids = item.cases
      .filter((row) => row.runId === runId && !row.resolvedAt)
      .map((row) => row.id);
    await JobsDiagnosticHistory?.caseRetention(item.url, runId, ids);
  }
  async function capture(value, runId, sender) {
    if (
      sender.id !== chrome.runtime.id ||
      !Number.isInteger(sender.tab?.id) ||
      !Number.isInteger(sender.frameId) ||
      !sender.url?.startsWith("https://")
    )
      throw Error("Invalid reproduction sender");
    JobsReproCase.validate(value);
    const url = new URL(sender.url);
    if (url.origin !== value.origin)
      throw Error("Reproduction origin mismatch");
    if (
      runId !== undefined &&
      (typeof runId !== "string" || !runId || runId.length > 200)
    )
      throw Error("Invalid run identity");
    const identity = JobsJobMatch.key(url.href);
    if (!identity) throw Error("Job identity unavailable");
    const key = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(identity),
        ),
      ),
      (n) => n.toString(16).padStart(2, "0"),
    ).join("");
    let publicUrl;
    try {
      publicUrl = publicJobUrl(url.href);
    } catch {}
    return serial(async () => {
      const state = await read();
      prune(state);
      const item = state.applications[key] || {
        cases: [],
        url: publicUrl,
        at: undefined,
        fingerprint: undefined,
      };
      const fingerprint = JSON.stringify({
        runId,
        build: value.build,
        fields: value.fields,
        timeline: value.timeline.map(({ ms, ...event }) => event),
      });
      if (item.fingerprint === fingerprint) {
        await link(item, runId);
        return;
      }
      if (
        runId &&
        item.cases.filter((row) => row.runId === runId && !row.resolvedAt)
          .length >= 100
      )
        throw Error("本轮未解决案例已达 100 个；现有证据已保留，请先处理故障");
      const at = Math.max(
        Date.now(),
        ...Object.values(state.applications).map((a) => (a.at || 0) + 1),
      );
      item.cases.push({ id: crypto.randomUUID(), at, value, runId });
      item.at = at;
      item.fingerprint = fingerprint;
      state.applications[key] = item;
      if (new TextEncoder().encode(JSON.stringify(state)).length > MAX_BYTES)
        throw Error(
          "故障案例存储已满；未解决案例不会自动删除，请导出并验证修复后标记已解决",
        );
      await write(state);
      await link(item, runId);
    });
  }
  const ui = (sender) =>
    sender.id === chrome.runtime.id &&
    !sender.tab &&
    sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL("diagnostics.html");
  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (
      ![
        "jobs:repro-push",
        "jobs:repro-list",
        "jobs:repro-get",
        "jobs:repro-resolve",
      ].includes(m?.type)
    )
      return;
    if (m.type !== "jobs:repro-push" && !ui(sender)) {
      reply({ error: "Private diagnostics page required" });
      return;
    }
    const task =
      m.type === "jobs:repro-push"
        ? capture(m.value, m.runId, sender)
        : serial(async () => {
            const state = await read();
            prune(state);
            if (m.type === "jobs:repro-resolve") {
              if (typeof m.resolved !== "boolean")
                throw Error("Invalid case resolution");
              const item = Object.values(state.applications).find((item) =>
                item.cases.some((row) => row.id === m.id),
              );
              const row = item?.cases.find((row) => row.id === m.id);
              if (!row) throw Error("案例不存在");
              row.resolvedAt = m.resolved ? Date.now() : undefined;
              await write(state);
              await link(item, row.runId);
              return { ok: true };
            }
            await write(state);
            const all = Object.values(state.applications)
              .flatMap((a) => a.cases)
              .sort((a, b) => b.at - a.at);
            return m.type === "jobs:repro-get"
              ? all.find((c) => c.id === m.id)?.value
              : all.map((c) => ({
                  id: c.id,
                  at: c.at,
                  ats: c.value.ats,
                  origin: c.value.origin,
                  build: c.value.build,
                  fields: c.value.fields.length,
                  resolved: !!c.resolvedAt,
                }));
          });
    task.then(
      (data) => reply({ data }),
      (error) => reply({ error: error.message }),
    );
    return true;
  });
}
