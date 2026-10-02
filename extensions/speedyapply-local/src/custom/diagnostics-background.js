import { JobsPrivateSession } from "./private-session.js";
import { JobsDiagnosticHistory } from "./history-background.js";
export var JobsDiagnosticsBackground;
let initialized = false;
export function initializeDiagnosticsBackground() {
  if (initialized) return;
  initialized = true;
  (() => {
    const KEY = "jobsDiagnosticsV1";
    /** @type {Promise<unknown>} */
    let queue = Promise.resolve();
    /** @template T @param {() => T|PromiseLike<T>} fn @returns {Promise<T>} */
    const serial = (fn) => {
      const next = queue.then(fn);
      queue = next.catch(() => {});
      return next;
    };
    const bytes = (data) =>
      new TextEncoder().encode(JSON.stringify(data)).byteLength;
    const stateEpochs = new WeakMap();
    const pageRevisions = new Map();
    const revision = (tabId) => pageRevisions.get(tabId) || 0;
    const read = async () => {
      const epoch = JobsPrivateSession.epoch;
      const value =
        /** @type {import('./worker-types.js').DiagnosticArchiveState} */ (
          (await chrome.storage.session.get(KEY))[KEY]
        ) || { reports: {}, sync: {} };
      JobsPrivateSession.assertCurrent(epoch);
      stateEpochs.set(value, epoch);
      return value;
    };
    const write = (value) =>
      JobsPrivateSession.commit(stateEpochs.get(value), { [KEY]: value });
    const key = (tab, frame, session) => `${tab}:${frame}:${session}`;
    function ui(sender) {
      try {
        return (
          sender.id === chrome.runtime.id &&
          new URL(sender.url).href.split(/[?#]/)[0] ===
            chrome.runtime.getURL("diagnostics.html")
        );
      } catch {
        return false;
      }
    }
    /** @param {import('./worker-types.js').DiagnosticReport} report */
    async function accept(
      report,
      sender,
      epoch = JobsPrivateSession.epoch,
      pageRevision = revision(sender.tab?.id),
    ) {
      JobsPrivateSession.assertCurrent(epoch);
      if (
        sender.id !== chrome.runtime.id ||
        !Number.isInteger(sender.tab?.id) ||
        !Number.isInteger(sender.frameId) ||
        !sender.url?.startsWith("https://")
      )
        throw Error("Invalid diagnostic sender");
      if (
        report?.schemaVersion !== 2 ||
        !["values_omitted", "fill_trace_values_only"].includes(
          report.valuePolicy,
        ) ||
        report.verdict !== "observation_only" ||
        !/^[a-f0-9-]{36}$/i.test(report.sessionId || "") ||
        bytes(report) > 240000
      )
        throw Error("Invalid diagnostic report");
      const id = key(sender.tab.id, sender.frameId, report.sessionId);
      await serial(async () => {
        const state = await read();
        JobsPrivateSession.assertCurrent(epoch);
        if (revision(sender.tab.id) !== pageRevision) throw Error("页面已离开");
        state.reports[id] = {
          id,
          tabId: sender.tab.id,
          frameId: sender.frameId,
          documentId: sender.documentId,
          receivedAt: Date.now(),
          revision: (state.reports[id]?.revision || 0) + 1,
          report,
        };
        for (const [oldId, old] of Object.entries(state.reports))
          if (oldId !== id && Date.now() - old.receivedAt > 86400000)
            delete state.reports[oldId];
        const oldest = () =>
          Object.values(state.reports).sort(
            (a, b) => a.receivedAt - b.receivedAt,
          )[0]?.id;
        while (
          Object.keys(state.reports).length > 40 ||
          bytes(state) > 512 * 1024
        )
          delete state.reports[oldest()];
        await write(state);
      });
      await JobsDiagnosticHistory?.capture(report);
      return { ok: true };
    }
    async function refresh(id) {
      const epoch = JobsPrivateSession.epoch;
      const state = await serial(read),
        row = state.reports[id];
      if (!row) throw Error("记录不存在");
      const pageRevision = revision(row.tabId);
      let timeout;
      try {
        const reply = await Promise.race([
          chrome.tabs.sendMessage(
            row.tabId,
            { type: "jobs:diagnostics-inspect" },
            row.documentId
              ? { documentId: row.documentId }
              : { frameId: row.frameId },
          ),
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(Error("页面未响应，保留旧记录")),
              2500,
            );
          }),
        ]);
        if (!reply?.data || reply.data.sessionId !== row.report.sessionId)
          throw Error("页面已切换，保留旧记录");
        JobsPrivateSession.assertCurrent(epoch);
        await accept(
          reply.data,
          {
            id: chrome.runtime.id,
            tab: { id: row.tabId },
            frameId: row.frameId,
            documentId: row.documentId,
            url: row.report.pageUrl,
          },
          epoch,
          pageRevision,
        );
        return (await serial(read)).reports[id];
      } finally {
        clearTimeout(timeout);
      }
    }
    async function captureCase(id) {
      const row = (await serial(read)).reports[id];
      if (!row) throw Error("记录不存在");
      let timeout;
      try {
        const response = await Promise.race([
          chrome.tabs.sendMessage(
            row.tabId,
            { type: "jobs:repro-capture", sessionId: row.report.sessionId },
            row.documentId
              ? { documentId: row.documentId }
              : { frameId: row.frameId },
          ),
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(Error("页面未响应，可导出之前保存的案例")),
              4000,
            );
          }),
        ]);
        if (response?.error) throw Error(response.error);
        return response?.data;
      } finally {
        clearTimeout(timeout);
      }
    }
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (
        ![
          "jobs:diagnostics-push",
          "jobs:diagnostics-list",
          "jobs:diagnostics-get",
          "jobs:diagnostics-refresh",
          "jobs:diagnostics-capture-case",
        ].includes(message?.type)
      )
        return;
      if (message.type !== "jobs:diagnostics-push" && !ui(sender)) {
        reply({ error: "Private diagnostics page required" });
        return;
      }
      const task =
        message.type === "jobs:diagnostics-capture-case"
          ? captureCase(message.id)
          : message.type === "jobs:diagnostics-push"
            ? accept(message.report, sender)
            : message.type === "jobs:diagnostics-refresh"
              ? refresh(message.id)
              : serial(async () => {
                  const state = await read(),
                    bridge =
                      /** @type {import('./worker-types.js').BrowserControlState|undefined} */ (
                        (
                          await chrome.storage.session.get(
                            "jobsBrowserControlV1",
                          )
                        ).jobsBrowserControlV1
                      );
                  return message.type === "jobs:diagnostics-get"
                    ? state.reports[message.id]
                    : {
                        sync: bridge?.error
                          ? { state: "error", message: bridge?.error }
                          : bridge?.lastExchangeAt
                            ? { state: "synced", at: bridge?.lastExchangeAt }
                            : { state: "local" },
                        reports: Object.values(state.reports).map(
                          ({ report, ...row }) => ({
                            ...row,
                            pageUrl: report.pageUrl,
                            ats: report.ats,
                            profileName: report.profileName,
                            counts: report.counts,
                            phase: report.phase,
                          }),
                        ),
                      };
                });
      task.then(
        (data) => reply({ data }),
        (error) => reply({ error: error.message }),
      );
      return true;
    });
    function releasePage(tabId, documentId = null) {
      pageRevisions.set(tabId, revision(tabId) + 1);
      return serial(async () => {
        const state = await read();
        for (const [id, row] of Object.entries(state.reports))
          if (
            row.tabId === tabId &&
            (!documentId || row.documentId === documentId)
          )
            delete state.reports[id];
        await write(state);
      });
    }
    chrome.tabs.onRemoved?.addListener(
      (tabId) => void releasePage(tabId).catch(() => {}),
    );
    JobsDiagnosticsBackground = { accept, refresh, releasePage };
  })();
}
