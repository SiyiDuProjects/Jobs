import { JobsPrivateSession } from "./private-session.js";
import { checkRecoveryPause } from "./recovery-pause.js";
import { publicJobUrl } from "./public-job-url.js";
import { JobsJobMatch } from "./job-match.js";
import { JobsBuildInfo } from "./build-info.js";
import { JobsSync } from "./sync.js";
import { JobsBrand } from "./brand.js";
import { createDiagnosticHistoryStore } from "./history-store.js";
import { historyEventMetrics } from "./history-event-metrics.js";
export var JobsDiagnosticHistory;
let initialized = false;
export function initializeHistoryBackground() {
  if (initialized) return;
  initialized = true;
  (() => {
    const MAX_BYTES = 150000,
      MAX_ARCHIVE_BYTES = 25000000,
      MAX_RUNS = 1000,
      RETENTION_MS = 30 * 86400000;
    let queue = Promise.resolve();
    /** @template T @param {()=>T|Promise<T>} fn @returns {Promise<T>} */
    const serial = (fn) => {
      const task = queue.then(fn);
      queue = task.then(
        () => {},
        () => {},
      );
      return task;
    };
    const store = createDiagnosticHistoryStore();
    const { read, write } = store;
    const bytes = (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const identity = publicJobUrl;
    const clean = (value) =>
      String(value ?? "")
        .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]")
        .replace(/(?:\+?\d[\s().-]*){7,}/g, "[number]")
        .slice(0, 300);
    const secret =
      /password|passcode|one.?time|verification code|social security|\bssn\b|验证码|密码/i;
    const short = (value, limit) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, limit);
    // Times order a field's earlier rule decision against its later writes.
    const decision = (d) => ({
      ...Object.fromEntries(
        ["status", "source", "reason", "field", "ruleId"]
          .filter((k) => short(d[k], 80))
          .map((k) => [k, short(d[k], 80)]),
      ),
      ...(Number.isInteger(d.at) ? { at: d.at } : {}),
    });
    // A browser-session salt never enters persistent diagnostics or uploads.
    // Equal values in one run retain the same opaque token across worker restarts.
    async function redactor(report, runId) {
      const key = "jobsDiagnosticSaltV2";
      let salt = (await chrome.storage.session.get(key))[key];
      if (!salt) {
        salt = crypto.randomUUID();
        await chrome.storage.session.set({ [key]: salt });
      }
      const values = new Set();
      for (const field of report.fields || []) {
        if (field.value != null) values.add(String(field.value));
        for (const item of field.traces || [])
          for (const value of [
            item.answer,
            item.chosen,
            item.alias,
            item.readback,
            ...(item.options || []),
          ])
            if (value != null) values.add(String(value));
      }
      const aliases = new Map();
      for (const value of values) {
        const bytes = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(salt + "\0" + runId + "\0" + value),
        );
        aliases.set(
          value,
          "synthetic-" +
            Array.from(new Uint8Array(bytes).slice(0, 16), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join(""),
        );
      }
      const synthetic = (value) => aliases.get(String(value ?? "")) || "";
      const publicText = (value) => {
        let result = String(value ?? "");
        for (const [privateValue, token] of [...aliases].sort(
          (a, b) => b[0].length - a[0].length,
        ))
          if (privateValue.length >= 3)
            result = result.split(privateValue).join(token);
        return clean(result);
      };
      const trace = (t) => ({
        ...Object.fromEntries(
          ["source", "topic", "result", "method", "reason"]
            .filter((k) => short(t[k], 40))
            .map((k) => [k, publicText(short(t[k], 40))]),
        ),
        ...Object.fromEntries(
          ["answer", "chosen", "alias", "readback"]
            .filter((k) => t[k] != null && t[k] !== "")
            .map((k) => [k, synthetic(t[k])]),
        ),
        ...(Number.isInteger(t.at) ? { at: t.at } : {}),
        ...(Number.isInteger(t.optionCount)
          ? { optionCount: t.optionCount }
          : {}),
        ...(Array.isArray(t.options)
          ? { options: t.options.slice(0, 12).map(synthetic) }
          : {}),
      });
      return { synthetic, publicText, trace };
    }
    async function capture(report) {
      return serial(async () => {
        if (
          !["values_omitted", "fill_trace_values_only"].includes(
            report?.valuePolicy,
          ) ||
          !report.sessionId ||
          !Number.isFinite(report.observedAt)
        )
          return;
        const url = identity(report.pageUrl),
          at = report.observedAt;
        const runId =
          report.runId ||
          report.sessionId +
            ":" +
            ((report.events || [])
              .filter((event) => event.type === "auto_step_started")
              .at(-1)?.at ||
              report.startedAt ||
              0);
        const storageKey = JobsJobMatch.key(report.pageUrl) + "|" + runId;
        const state = await read(storageKey);
        const { synthetic, publicText, trace } = await redactor(report, runId);
        const entry = state.applications[storageKey] || {
          revision: 0,
          ack: 0,
          signature: undefined,
          data: {
            caseRetention: undefined,
            schemaVersion: 2,
            runId,
            build: report.build || JobsBuildInfo?.id || "unknown",
            url,
            ats: report.ats,
            firstSeen: report.startedAt || at,
            lastSeen: at,
            snapshots: [],
            events: [],
            truncated: false,
          },
        };
        if (
          !state.applications[storageKey] &&
          !report.fields?.length &&
          !report.unansweredContainers?.length
        )
          return;
        const data = entry.data;
        if (state.retentions?.[storageKey])
          data.caseRetention = state.retentions[storageKey];
        const snapshot = {
          at,
          document: report.sessionId,
          phase: report.phase || "unknown",
          step: publicText(report.step),
          fields: (report.fields || [])
            .filter(
              (f) =>
                !secret.test(f.question || "") &&
                !["password", "hidden"].includes(f.kind),
            )
            .slice(0, 150)
            .map((f) => ({
              id: f.id,
              question: publicText(f.question),
              kind: f.kind,
              required: !!f.required,
              hasValue: !!f.hasValue,
              invalid: !!f.invalid,
              status: f.status || "unknown",
              attempts: f.attempts || 0,
              // Why the field holds what it holds: the answer decision and the last
              // write's choice. This is what a later "why was this wrong" needs.
              ...(f.value ? { value: synthetic(f.value) } : {}),
              ...(f.decision ? { decision: decision(f.decision) } : {}),
              ...(f.traces?.length ? { trace: trace(f.traces.at(-1)) } : {}),
            })),
          // Questions no reader turned into a field, with their structure only.
          ...(report.unansweredContainers?.length
            ? {
                unrecognized: report.unansweredContainers
                  .slice(0, 20)
                  .map((u) => ({
                    question: publicText(u.question).slice(0, 200),
                    reason: short(u.reason, 40),
                    structure: String(u.structure || "").slice(0, 800),
                  })),
              }
            : {}),
        };
        const signature = JSON.stringify({ ...snapshot, at: 0 });
        let changed = entry.signature !== signature;
        if (changed) {
          data.snapshots.push(snapshot);
          entry.signature = signature;
        }
        // Storage may reorder object properties. Event identity must not depend
        // on that order, including when compacting already duplicated history.
        const eventKey = (e) =>
          JSON.stringify([
            e.at,
            e.document,
            e.type,
            e.fieldId || null,
            e.phase || null,
            e.build || null,
            e.visibility || null,
            historyEventMetrics(e.type, e.timing).timing || null,
          ]);
        const priorEventCount = data.events.length;
        data.events = [
          ...new Map(
            data.events.map((e) => /** @type {const} */ ([eventKey(e), e])),
          ).values(),
        ];
        changed ||= data.events.length !== priorEventCount;
        const known = new Set(data.events.map(eventKey));
        for (const e of report.events || []) {
          const event = /** @type {import('./sync-types').HistoryEvent} */ ({
            at: e.at,
            document: report.sessionId,
            type: e.type,
            ...(e.fieldId ? { fieldId: e.fieldId } : {}),
            ...historyEventMetrics(e.type, e.detail),
          });
          if (e.type === "phase" && /^[a-z_-]{1,80}$/.test(e.detail || ""))
            event.phase = e.detail;
          if (e.type === "build_info") {
            try {
              const id = JSON.parse(e.detail).build;
              if (/^[a-f0-9]{16}$/.test(id)) event.build = id;
            } catch {}
          }
          const key = eventKey(event);
          if (!known.has(key)) {
            data.events.push(event);
            known.add(key);
            changed = true;
          }
        }
        if (!changed) return;
        data.firstSeen = Math.min(data.firstSeen, report.startedAt || at);
        data.lastSeen = Math.max(data.lastSeen, at);
        data.events.sort((a, b) => a.at - b.at);
        if (data.snapshots.length > 60) {
          data.snapshots = data.snapshots.slice(-60);
          data.truncated = true;
        }
        if (data.events.length > 1500) {
          data.events = data.events.slice(-1500);
          data.truncated = true;
        }
        if ((report.fields?.length || 0) > 150 || report.droppedEvents > 0)
          data.truncated = true;
        while (bytes(data) > MAX_BYTES) {
          data.truncated = true;
          if (data.snapshots.length > 1) data.snapshots.shift();
          else if (data.events.length) data.events.shift();
          else data.snapshots[0].fields.pop();
        }
        entry.revision++;
        state.applications[storageKey] = entry;
        // Unacknowledged diagnostics and unresolved cases survive disconnection.
        // Ordinary acknowledged records expire after the agreed 30 days.
        for (const [key, row] of Object.entries(state.applications))
          if (
            !row.pinned &&
            !row.data.caseRetention?.unresolvedCaseIds.length &&
            row.ack === row.revision &&
            Date.now() - row.data.lastSeen > RETENTION_MS
          ) {
            delete state.applications[key];
            delete state.retentions?.[key];
          }
        const disposable = Object.entries(state.applications)
          .filter(
            ([, row]) =>
              !row.pinned &&
              !row.data.caseRetention?.unresolvedCaseIds.length &&
              row.ack === row.revision,
          )
          .sort((a, b) => a[1].data.lastSeen - b[1].data.lastSeen);
        while (
          Object.keys(state.applications).length > MAX_RUNS ||
          store.size(state) > MAX_ARCHIVE_BYTES
        ) {
          const oldest = disposable.shift();
          if (!oldest)
            throw Error(
              "诊断存储已满；未上传或未解决的记录已保留，请联网同步或处理故障案例",
            );
          delete state.applications[oldest[0]];
          delete state.retentions?.[oldest[0]];
        }
        await write(state);
      });
    }
    async function pending(budget) {
      return serial(async () => {
        const state = await read(),
          items = [],
          ack = [];
        let used = 0;
        for (const [url, entry] of Object.entries(state.applications).sort(
          (a, b) => a[1].data.lastSeen - b[1].data.lastSeen,
        )) {
          if (entry.ack === entry.revision) continue;
          const size = bytes(entry.data);
          if (used + size > budget) continue;
          items.push(entry.data);
          ack.push({ url, revision: entry.revision });
          used += size;
        }
        return { items, ack };
      });
    }
    async function acknowledge(sent, epoch = undefined) {
      return serial(async () => {
        const state = await read();
        const check =
          epoch === undefined
            ? undefined
            : () => JobsPrivateSession.assertCurrent(epoch);
        check?.();
        const pendingAcks = {};
        for (const { url, revision } of sent) {
          const entry = state.applications[url];
          if (entry && revision > entry.ack) {
            pendingAcks[url] = entry.ack;
            entry.ack = revision;
          }
        }
        await write(state, check ? { check, pendingAcks } : undefined);
      });
    }
    let uploading;
    async function upload() {
      const epoch = JobsPrivateSession.epoch;
      await JobsSync.ready;
      const connection = /** @type {import('./sync-types').SyncState} */ (
        (await chrome.storage.local.get("jobsSyncV1")).jobsSyncV1
      );
      if (!connection?.profileToken || connection.disabled) return;
      const batch = await pending(495000);
      if (!batch.items.length) return;
      const origin = JobsBrand.origin;
      if (!origin) throw Error("Diagnostics connection is unavailable");
      JobsPrivateSession.assertCurrent(epoch);
      const post = async (history) => {
        JobsPrivateSession.assertCurrent(epoch);
        const response = await fetch(origin + "/api/extension/diagnostics", {
          method: "POST",
          credentials: "omit",
          headers: {
            "X-Jobs-Protocol": "2",
            "Content-Type": "application/json",
            Authorization: "Bearer " + connection.profileToken,
          },
          body: JSON.stringify({ protocolVersion: 1, history }),
          signal: AbortSignal.timeout(10000),
        });
        await checkRecoveryPause(response, epoch);
        JobsPrivateSession.assertCurrent(epoch);
        if (!response.ok) return { status: response.status };
        const data = await response.json();
        JobsPrivateSession.assertCurrent(epoch);
        if (data.historyAccepted !== true)
          throw Error("Diagnostics were not acknowledged");
        return { status: 0, metrics: data.historyEventMetrics === 1 };
      };
      const accepted = (response) => {
        if (response.status)
          throw Error("Diagnostics upload failed (" + response.status + ")");
        return response;
      };
      const hasMetrics = batch.items.some((item) =>
        item.events.some((event) => event.timing || event.visibility),
      );
      const legacy = () =>
        batch.items.map((item) => ({
          ...item,
          events: item.events.map(({ timing, visibility, ...event }) => event),
        }));
      // Probe with the existing empty-packet contract. Old servers never see
      // new event fields; the local archive still retains those measurements.
      const metrics = hasMetrics && accepted(await post([])).metrics;
      const response = await post(
        hasMetrics && !metrics ? legacy() : batch.items,
      );
      // The service can roll back between the probe and packet. Retry only a
      // rejected rich shape, once; auth/pause/network failures keep it pending.
      accepted(
        metrics && response.status === 400 ? await post(legacy()) : response,
      );
      JobsPrivateSession.assertCurrent(epoch);
      await acknowledge(batch.ack, epoch);
    }
    function sync() {
      if (!uploading)
        uploading = upload().finally(() => {
          uploading = null;
        });
      return uploading;
    }
    async function pin(url, value = true) {
      return serial(async () => {
        const state = await read(),
          key = identity(url);
        for (const row of Object.values(state.applications))
          if (row.data.url === key) row.pinned = value === true;
        await write(state);
      });
    }
    chrome.alarms?.onAlarm.addListener((alarm) => {
      if (alarm.name === "jobs-diagnostics") void sync().catch(() => {});
    });
    chrome.alarms?.create("jobs-diagnostics", { periodInMinutes: 0.5 });
    async function caseRetention(url, runId, unresolvedCaseIds) {
      if (
        typeof runId !== "string" ||
        !runId ||
        runId.length > 200 ||
        !Array.isArray(unresolvedCaseIds) ||
        unresolvedCaseIds.length > 100 ||
        unresolvedCaseIds.some(
          (id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id),
        )
      )
        throw Error("Invalid case retention");
      const safe = identity(url),
        key = JobsJobMatch.key(safe) + "|" + runId,
        ids = [...new Set(unresolvedCaseIds)].sort();
      await serial(async () => {
        const state = await read();
        state.retentions ??= {};
        const previous = state.retentions[key];
        if (JSON.stringify(previous?.unresolvedCaseIds) === JSON.stringify(ids))
          return;
        const retention = {
          revision: (previous?.revision || 0) + 1,
          unresolvedCaseIds: ids,
        };
        state.retentions[key] = retention;
        const entry = state.applications[key];
        if (entry) {
          entry.data.caseRetention = retention;
          entry.revision++;
        }
        await write(state);
      });
      void sync().catch(() => {});
    }
    JobsDiagnosticHistory = {
      capture,
      pending,
      acknowledge,
      sync,
      pin,
      caseRetention,
    };
  })();
}
