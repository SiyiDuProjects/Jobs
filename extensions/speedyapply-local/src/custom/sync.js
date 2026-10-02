import { JobsPrivateSession } from "./private-session.js";
import { checkRecoveryPause } from "./recovery-pause.js";
import { JobsBrand } from "./brand.js";
import { JobsStorageUpgrade } from "./storage-upgrade.js";
import { JobsMigrationMaintenance } from "./migration-maintenance.js";
import { JobsStorageMigrationPolicy } from "./storage-migration-policy.js";
import { publicJobUrl } from "./public-job-url.js";
import { JobsPrivateConnection } from "./private-connection.js";
import { JobsJobMatch } from "./job-match.js";
import { JobsAvailabilityRules } from "./availability-rules.js";
import { JobsManagementSync } from "./management-sync.js";
export var JobsSync;
let initialized = false;
export function initializeSync() {
  if (initialized) return;
  initialized = true;
  (() => {
    const ORIGIN = JobsBrand.origin;
    const KEY = "jobsSyncV1";
    let queue = Promise.resolve(),
      flushing;
    /** @template T @param {()=>T|Promise<T>} fn @returns {Promise<T>} */
    const serial = (fn) => {
      const task = queue.then(fn);
      queue = task.then(
        () => {},
        () => {},
      );
      return task;
    };
    const read = async () =>
      /** @type {import('./sync-types').SyncState} */ (
        (await chrome.storage.local.get(KEY))[KEY] || {
          deviceId: crypto.randomUUID(),
          outbox: [],
          connected: false,
        }
      );
    const write = (state) => chrome.storage.local.set({ [KEY]: state });
    const ready = serial(async () => {
      const config = JobsPrivateConnection;
      if (!config) return;
      if (
        config.extensionId !== chrome.runtime.id ||
        config.origin !== ORIGIN ||
        !/^[A-Za-z0-9_-]{64}$/.test(config.token) ||
        !/^[A-Za-z0-9_-]{64}$/.test(config.profileToken)
      )
        throw Error("Invalid private connection");
      const state = await read();
      if (state.disabled) return;
      // A new private build may rotate credentials without changing its device
      // ID. Keep only a digest for versioning; a website-paired newer token is
      // left alone on subsequent restarts of the same build.
      const bytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(config.token + ":" + config.profileToken),
      );
      const version = Array.from(new Uint8Array(bytes), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      if (
        state.privateDeviceId === config.deviceId &&
        state.privateConnectionVersion === version
      )
        return;
      Object.assign(state, {
        deviceId: config.deviceId,
        privateDeviceId: config.deviceId,
        privateConnectionVersion: version,
        token: config.token,
        profileToken: config.profileToken,
        error: "",
      });
      state.outbox.forEach((item) => {
        item.next = 0;
      });
      await write(state);
    });
    const siteSender = (sender) => {
      try {
        return !!sender.tab && new URL(sender.url).origin === ORIGIN;
      } catch {
        return false;
      }
    };
    const cleanUrl = publicJobUrl;
    const jobKey = (value) => {
      const key = JobsJobMatch.key(value);
      if (!key) throw Error("Job identity unavailable");
      return key;
    };
    const publicStatus = (state) => ({
      installed: true,
      connected: !!state.token,
      profilesConnected: !!state.profileToken,
      disabled: !!state.disabled,
      queued: state.outbox.length,
      needsConfirmation: state.needsConfirmation || 0,
      error: JobsStorageUpgrade.peek()?.message || state.error || "",
      lastSynced: state.lastSynced || null,
    });
    async function announce() {
      const state = await serial(read);
      const tabs = await chrome.tabs.query({ url: ORIGIN + "/*" });
      await Promise.allSettled(
        tabs.map((tab) =>
          chrome.tabs.sendMessage(tab.id, {
            type: "jobs:sync-status",
            ...publicStatus(state),
          }),
        ),
      );
    }
    async function record(application, source) {
      try {
        if (!source?.url || application.status !== "applied") return;
        const page = new URL(source.url),
          url = cleanUrl(application.jobLink);
        if (!["https:", "http:"].includes(page.protocol)) return;
        const target = new URL(url);
        let confirmationSource =
          page.hostname === target.hostname ||
          JobsJobMatch.same(source.url, url);
        // Indeed's receipt lives on SmartApply, while the job lives on www.indeed.
        // Only the background's existing, server-resolved tab binding may bridge
        // those hosts. A job URL or source URL supplied in an event is insufficient.
        if (
          !confirmationSource &&
          source.proof === "ats_confirmation" &&
          Number.isInteger(source.tabId) &&
          page.hostname === "smartapply.indeed.com" &&
          ["indeed.com", "www.indeed.com"].includes(target.hostname) &&
          /(?:^|\/)post-apply(?:\/|$)/.test(page.pathname)
        ) {
          const binding = /** @type {import('./tab-profiles').TabBinding} */ (
            (
              await chrome.storage.session.get("jobsTabBinding:" + source.tabId)
            )["jobsTabBinding:" + source.tabId]
          );
          const key = JobsJobMatch.key(url);
          if (key && /^[a-f0-9]{24}$/.test(binding?.websiteJobId || "")) {
            const bytes = await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(key),
            );
            const digest =
              "job:" +
              Array.from(new Uint8Array(bytes), (byte) =>
                byte.toString(16).padStart(2, "0"),
              ).join("");
            confirmationSource = binding.jobKey === digest;
          }
        }
        const proof =
          source.proof === "ats_confirmation" && confirmationSource
            ? "ats_confirmation"
            : ["submit_attempt", "submit_validation_error"].includes(
                  source.proof,
                )
              ? source.proof
              : "tracker_record";
        const payload = /** @type {import('./sync-types').EventPayload} */ ({
          event_id: source.eventId || crypto.randomUUID(),
          job_url: url,
          job_title: String(application.jobTitle || "").slice(0, 500),
          company: String(application.companyName || "").slice(0, 250),
          observed_at: new Date().toISOString(),
          proof,
        });
        if (source.profileId) payload.profile_id = source.profileId;
        if (application.profileName)
          payload.profile_name = application.profileName;
        await serial(async () => {
          const state = await read();
          if (state.disabled) return;
          const parsedDate = new Date(application.date || Date.now());
          const day = Number.isNaN(parsedDate.valueOf())
            ? new Date().toISOString().slice(0, 10)
            : parsedDate.toISOString().slice(0, 10);
          const dedupe = JSON.stringify([
            jobKey(url),
            payload.job_title,
            day,
            proof,
          ]);
          state.seen ||= {};
          if (state.seen[dedupe]) return;
          if (Number.isInteger(source.tabId)) {
            const binding = /** @type {import('./tab-profiles').TabBinding} */ (
              (
                await chrome.storage.session.get(
                  "jobsTabBinding:" + source.tabId,
                )
              )["jobsTabBinding:" + source.tabId]
            );
            if (binding?.websiteJobId)
              payload.website_job_id = binding.websiteJobId;
          }
          state.outbox.push({ payload, attempts: 0, next: 0 });
          state.seen[dedupe] = Date.now();
          for (const [key, at] of Object.entries(state.seen))
            if (Date.now() - at > 90 * 86400000) delete state.seen[key];
          await write(state);
        });
        void flush();
      } catch (error) {
        throw Error("申请事件未保存：" + String(error.message || error));
      }
    }
    async function availability(msg, sender) {
      await ready;
      if (
        sender.id !== chrome.runtime.id ||
        !sender.tab ||
        sender.frameId !== 0 ||
        sender.url !== msg.url
      )
        throw Error("Invalid page");
      const url = cleanUrl(sender.url),
        key = jobKey(url);
      if (!key || new URL(url).origin === ORIGIN)
        throw Error("Invalid job URL");
      const result = await serial(async () => {
        const state = await read();
        if (state.disabled) throw Error("同步已关闭，岗位未移除");
        state.availability ||= {};
        let row = state.availability[key];
        if (msg.type === "jobs:availability-status")
          return {
            removal_detail: row?.payload.detail || row?.result?.removal_detail,
            ...(row?.undo && row.result?.state === "removed"
              ? { ...row.result, state: "restoring", sync_error: state.error }
              : row?.result || {
                  state: row ? "pending" : "ready",
                  event_id: row?.payload.event_id,
                  sync_error: row ? state.error : "",
                }),
          };
        if (msg.type === "jobs:availability-restore") {
          if (
            !row ||
            row.payload.event_id !== msg.eventId ||
            row.result?.state !== "removed"
          )
            throw Error("没有可恢复的移除记录");
          if (!row.undo) {
            row.undo = {
              event_id: crypto.randomUUID(),
              proof: "undo_unavailable",
              removal_event: msg.eventId,
            };
            state.outbox.push({
              payload: row.undo,
              availabilityKey: key,
              attempts: 0,
              next: 0,
            });
          }
          row.tabId = sender.tab.id;
          await write(state);
          return { ...row.result, state: "restoring" };
        }
        const manual = msg.type === "jobs:availability-delete";
        if (
          manual &&
          (typeof msg.detail !== "string" ||
            !msg.detail.trim() ||
            msg.detail.length > 500)
        )
          throw Error("请填写删除原因（最多 500 字）");
        if (
          !manual &&
          (JobsAvailabilityRules?.code(msg.quote) !== msg.code || !msg.code)
        )
          throw Error("Invalid terminal message");
        // Explicit owner deletion may follow an undo. In-flight removals keep their ID.
        if (
          manual &&
          row?.result &&
          [
            "restored",
            "expired",
            "unmatched",
            "protected",
            "restore_expired",
            "restore_conflict",
          ].includes(row.result.state)
        )
          row = null;
        if (!row) {
          const payload = {
            event_id: crypto.randomUUID(),
            proof: manual ? "manual_remove" : "ats_unavailable",
            job_url: url,
            observed_at: new Date().toISOString(),
            code: manual ? "manual" : msg.code,
            quote: manual
              ? "用户在插件中手动删除岗位"
              : JobsAvailabilityRules.normalize(msg.quote),
          };
          if (manual) payload.detail = msg.detail.trim();
          const binding = /** @type {import('./tab-profiles').TabBinding} */ (
            (
              await chrome.storage.session.get(
                "jobsTabBinding:" + sender.tab.id,
              )
            )["jobsTabBinding:" + sender.tab.id]
          );
          const hint = binding?.websiteJobId;
          if (hint) payload.website_job_id = hint;
          row = state.availability[key] = {
            payload,
            tabId: sender.tab.id,
            at: Date.now(),
          };
          state.outbox.push({
            payload,
            availabilityKey: key,
            attempts: 0,
            next: 0,
          });
        }
        row.tabId = sender.tab.id;
        // Keep outstanding receipts and their undo metadata until acknowledged.
        for (const [k, item] of Object.entries(state.availability))
          if (
            item.at < Date.now() - 7 * 86400000 &&
            !state.outbox.some((e) => e.availabilityKey === k)
          )
            delete state.availability[k];
        await write(state);
        return (
          row.result || {
            state: "pending",
            event_id: row.payload.event_id,
            removal_detail: row.payload.detail,
          }
        );
      });
      void flush();
      return result;
    }
    async function jobAction(msg, sender) {
      if (
        sender.id !== chrome.runtime.id ||
        !["status", "delete", "restore"].includes(msg.action)
      )
        throw Error("Invalid job action");
      if (sender.tab || sender.url !== chrome.runtime.getURL("popup.html"))
        throw Error("请从插件小窗口操作");
      if (!Number.isInteger(msg.tabId)) throw Error("没有可操作的岗位页面");
      const tab = await chrome.tabs.get(msg.tabId);
      if (!tab || tab.url !== msg.url)
        throw Error("页面已变化，请重新打开插件");
      if (!tab.active) throw Error("页面已切换，请重新打开插件");
      const url = cleanUrl(tab.url);
      if (new URL(url).origin === ORIGIN || !JobsJobMatch.key(url))
        throw Error("当前页面无法识别岗位");
      return availability(
        {
          ...msg,
          type: {
            status: "jobs:availability-status",
            delete: "jobs:availability-delete",
            restore: "jobs:availability-restore",
          }[msg.action],
        },
        { id: chrome.runtime.id, tab, frameId: 0, url: tab.url },
      );
    }
    async function run() {
      for (let i = 0; i < 10; i++) {
        const snapshot = await serial(read);
        if (!snapshot.token || snapshot.disabled) break;
        const entry = snapshot.outbox.find((item) => item.next <= Date.now());
        if (!entry) break;
        let result,
          code = 0;
        try {
          const response = await fetch(ORIGIN + "/api/extension/events", {
            method: "POST",
            credentials: "omit",
            headers: {
              "X-Jobs-Protocol": "2",
              "Content-Type": "application/json",
              Authorization: "Bearer " + snapshot.token,
            },
            body: JSON.stringify(entry.payload),
            signal: AbortSignal.timeout(10000),
          });
          code = response.status;
          await checkRecoveryPause(response);
          if (response.ok) result = await response.json();
        } catch {
          /* Persist the receipt and retry on the next alarm. */
        }
        await serial(async () => {
          const state = await read();
          if (state.token !== snapshot.token) return;
          const current = state.outbox.find(
            (item) => item.payload.event_id === entry.payload.event_id,
          );
          if (!current) return;
          if (code === 426) {
            state.error = "插件版本需要更新，请重新加载最新插件";
            current.next = Date.now() + 86400000;
          } else if (code === 401) {
            delete state.token;
            state.error = "连接已过期，请打开 jobs 网站重新连接";
          } else if (
            entry.availabilityKey &&
            result?.event_id === entry.payload.event_id &&
            [
              "removed",
              "already_removed",
              "protected",
              "unmatched",
              "expired",
              "restored",
              "restore_expired",
              "restore_conflict",
            ].includes(result.state)
          ) {
            const row = state.availability?.[entry.availabilityKey];
            if (row) {
              row.result = result;
              if (row.payload.proof !== "manual_remove")
                void chrome.tabs
                  .sendMessage(
                    row.tabId,
                    {
                      type: "jobs:availability-result",
                      url: row.payload.job_url,
                      data: result,
                    },
                    { frameId: 0 },
                  )
                  .catch(() => {});
            }
            state.outbox = state.outbox.filter((item) => item !== current);
            state.lastSynced = Date.now();
            state.error = "";
          } else if (
            result &&
            result.event_id === entry.payload.event_id &&
            [
              "submitted",
              "submitted_unconfirmed",
              "ignored_after_undo",
              "submission_error",
              "submitted_error",
              "already_submitted",
              "recorded",
              "needs_confirmation",
            ].includes(result.state)
          ) {
            state.outbox = state.outbox.filter((item) => item !== current);
            if (result.state === "needs_confirmation")
              state.needsConfirmation = (state.needsConfirmation || 0) + 1;
            state.lastSynced = Date.now();
            state.error = "";
          } else {
            current.attempts++;
            current.next =
              Date.now() +
              Math.min(86400000, 60000 * 2 ** Math.min(current.attempts, 11));
            state.error =
              result?.state === "unmatched"
                ? "有投递暂未匹配到网站岗位，已保留并会重试"
                : result?.state === "held"
                  ? "岗位正在处理中，稍后自动同步"
                  : "有记录待同步，将自动重试";
          }
          await write(state);
        });
        if (code === 401 || code === 426) break;
      }
      await announce();
    }
    function flush() {
      if (!flushing)
        flushing = run()
          .catch(() => {})
          .finally(() => {
            flushing = undefined;
          });
      return flushing;
    }
    async function reconnectCheck(profileToken) {
      const fail = (message) => {
        throw Object.assign(Error(message), { connectionMessage: message });
      };
      const pending = (await JobsManagementSync?.pendingSnapshot?.()) || {};
      const ids = Object.keys(pending)
        .filter((key) => key.startsWith("jobsResponses:"))
        .map((key) => key.slice("jobsResponses:".length));
      let allowed = new Set();
      if (ids.length) {
        if (!profileToken)
          fail("有个人回答待恢复，请同时连接对应的 Profile 后重试");
        const response = await fetch(ORIGIN + "/api/extension/profiles", {
          method: "GET",
          credentials: "omit",
          headers: {
            "X-Jobs-Protocol": "2",
            Authorization: "Bearer " + profileToken,
          },
          signal: AbortSignal.timeout(20000),
        });
        await checkRecoveryPause(response);
        const list = await response.json();
        if (!response.ok || !Array.isArray(list))
          fail("无法核对待恢复回答所属的 Profile，原草稿已保留");
        allowed = new Set(list.map((row) => row.id));
      }
      return async () => {
        const current = (await JobsManagementSync?.pendingSnapshot?.()) || {};
        if (
          Object.keys(current).some(
            (key) =>
              key.startsWith("jobsResponses:") &&
              !allowed.has(key.slice("jobsResponses:".length)),
          )
        )
          fail("新连接不包含待恢复回答的原 Profile，已保留草稿且未更换连接");
      };
    }
    async function message(msg, sender) {
      if (!siteSender(sender)) throw Error("Invalid site");
      if (msg.type === "jobs:sync-status")
        return serial(async () => publicStatus(await read()));
      if (msg.type === "jobs:sync-pair-info")
        return serial(async () => {
          const state = await read();
          await write(state);
          return {
            deviceId: state.deviceId,
            extensionId: chrome.runtime.id,
            ...publicStatus(state),
          };
        });
      if (msg.type === "jobs:sync-connect") {
        if (
          typeof msg.token !== "string" ||
          !/^[A-Za-z0-9_-]{64}$/.test(msg.token)
        )
          throw Error("Invalid connection");
        const profileToken =
          typeof msg.profileToken === "string" &&
          /^[A-Za-z0-9_-]{64}$/.test(msg.profileToken)
            ? msg.profileToken
            : undefined;
        const epoch = JobsPrivateSession.epoch;
        const previous = await serial(read);
        const changing =
          previous.disabled ||
          previous.token !== msg.token ||
          (profileToken && previous.profileToken !== profileToken);
        const checkPending = changing
          ? await reconnectCheck(profileToken)
          : async () => {};
        await serial(async () => {
          const state = await read();
          JobsPrivateSession.assertCurrent(epoch);
          const changed =
            state.disabled ||
            state.token !== msg.token ||
            (profileToken && state.profileToken !== profileToken);
          if (changed) {
            await JobsPrivateSession.clear(
              checkPending,
              JobsManagementSync?.pendingSnapshot,
            );
            delete state.profileToken;
          }
          state.token = msg.token;
          if (profileToken) state.profileToken = profileToken;
          state.disabled = false;
          state.error = "";
          state.outbox.forEach((item) => {
            item.next = 0;
          });
          await write(state);
        });
        void flush();
        void JobsManagementSync?.profiles();
        void JobsManagementSync?.sync?.();
        return { ok: true };
      }
      if (msg.type === "jobs:sync-disconnect") {
        await JobsManagementSync?.prepareConnectionChange?.();
        await serial(async () => {
          const state = await read();
          await JobsPrivateSession.clear(
            JobsManagementSync?.assertNoPendingResponses,
          );
          delete state.token;
          delete state.profileToken;
          state.disabled = true;
          await write(state);
        });
        await announce();
        return { ok: true };
      }
      throw Error("Unknown message");
    }
    async function profileResult(response, token, fallback) {
      await checkRecoveryPause(response);
      // A proxy's HTML error page must not hide expired authentication or turn
      // an unsuccessful request into a successful empty profile response.
      let result;
      try {
        result = await response.json();
      } catch {
        /* handled below */
      }
      if (response.status === 401) {
        let expired = false;
        await serial(async () => {
          const state = await read();
          if (state.profileToken === token) {
            expired = true;
            delete state.profileToken;
            state.error = "个人资料连接已过期，请打开 jobs 网站恢复连接";
            await write(state);
          }
        });
        if (expired)
          await JobsPrivateSession.clear(
            undefined,
            JobsManagementSync?.pendingSnapshot,
          );
        throw Error("个人资料连接已过期，请打开 jobs 网站恢复连接");
      }
      if (!response.ok || result === undefined)
        throw Error(result?.error || fallback);
      return result;
    }
    async function profileRequest(payload) {
      await JobsMigrationMaintenance.assertOpen();
      await JobsStorageUpgrade.assertReady();
      const epoch = JobsPrivateSession.epoch;
      await ready;
      const state = await serial(read);
      if (!state.profileToken || state.disabled)
        throw Error("请打开 jobs 网站，连接个人资料同步");
      if (
        !/^\/api\/extension\/profiles(?:\/[a-f0-9-]{36})?$/.test(payload.path)
      )
        throw Error("Invalid Profile endpoint");
      const response = await fetch(ORIGIN + payload.path, {
        method: payload.method || "GET",
        credentials: "omit",
        headers: {
          "X-Jobs-Protocol": "2",
          "Content-Type": "application/json",
          Authorization: "Bearer " + state.profileToken,
        },
        ...(payload.body ? { body: JSON.stringify(payload.body) } : {}),
        signal: AbortSignal.timeout(20000),
      });
      const result = await profileResult(
        response,
        state.profileToken,
        "资料同步暂时失败，本地资料已保留",
      );
      JobsPrivateSession.assertCurrent(epoch);
      return result;
    }
    async function managementRequest(method, body) {
      await JobsMigrationMaintenance.assertOpen();
      const epoch = JobsPrivateSession.epoch;
      await ready;
      const state = await serial(read);
      if (!state.profileToken || state.disabled)
        throw Error("管理同步未连接，本地数据已保留");
      const response = await fetch(ORIGIN + "/api/manage/state", {
        method,
        credentials: "omit",
        headers: {
          "X-Jobs-Protocol": "2",
          "Content-Type": "application/json",
          Authorization: "Bearer " + state.profileToken,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20000),
      });
      const result = await profileResult(
        response,
        state.profileToken,
        "管理同步失败，本地数据已保留",
      );
      JobsPrivateSession.assertCurrent(epoch);
      return result;
    }
    async function migrationIdentity() {
      await ready;
      const state = await serial(read);
      if (!state.profileToken || state.disabled)
        throw Object.assign(Error("请先在 jobs 网站恢复个人资料连接"), {
          code: "migration_auth_required",
        });
      return { deviceId: state.deviceId };
    }
    async function migrationRequest(path, method = "GET", body = undefined) {
      await ready;
      const state = await serial(read);
      if (!state.profileToken || state.disabled)
        throw Object.assign(Error("请先在 jobs 网站恢复个人资料连接"), {
          code: "migration_auth_required",
        });
      const suffix = path.slice(JobsStorageMigrationPolicy.prefix.length);
      if (
        !path.startsWith(JobsStorageMigrationPolicy.prefix) ||
        !/^(?:\/[a-f0-9-]{36}(?:\/(?:entries\/[a-f0-9-]{36}|seal|plan|resolve|apply|verify|cleanup-claim|cleanup-ack|complete|supersede|conflicts\/[A-Za-z0-9_-]{1,128}\/preview\?choiceId=(?:[A-Za-z0-9_-]|%3A){1,128}(?:&cursor=[A-Za-z0-9_-]{1,256})?))?)?$/.test(
          suffix,
        ) ||
        !["GET", "POST", "PUT"].includes(method)
      )
        throw Error("Invalid migration endpoint");
      const response = await fetch(ORIGIN + path, {
        method,
        credentials: "omit",
        headers: {
          "X-Jobs-Protocol": "2",
          "Content-Type": "application/json",
          Authorization: "Bearer " + state.profileToken,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(
          JobsStorageMigrationPolicy.limits.requestTimeoutMs,
        ),
      });
      const result = await profileResult(
        response,
        state.profileToken,
        "迁移暂时无法连接，原资料已保留",
      );
      const current = await serial(read);
      if (
        current.disabled ||
        current.deviceId !== state.deviceId ||
        current.profileToken !== state.profileToken
      )
        throw Object.assign(Error("资料连接已改变，请重新核对迁移会话"), {
          code: "migration_owner_mismatch",
        });
      if (result?.deviceId !== undefined && result.deviceId !== state.deviceId)
        throw Object.assign(Error("迁移会话不属于当前设备"), {
          code: "migration_owner_mismatch",
        });
      return result;
    }
    async function generateAnswer(payload) {
      await JobsMigrationMaintenance.assertOpen();
      await ready;
      const state = await serial(read);
      if (!state.profileToken || state.disabled)
        throw Error("Luna 未连接 jobs 服务器");
      const {
        profile: unusedProfile,
        responseContext: unusedLegacyContext,
        ...answerRequest
      } = payload;
      if (!answerRequest.profileId || !answerRequest.profileVersion)
        throw Error("本页 Profile 版本不可用，请重新开始填写");
      const body = answerRequest;
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([state.deviceId, body])),
      );
      const key = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      const task = await serial(async () => {
        const tasks =
          /** @type {Record<string,import('./sync-types').AnswerTask>} */ (
            (await chrome.storage.session.get("jobsAnswerTasksV1"))
              .jobsAnswerTasksV1 || {}
          );
        for (const [id, item] of Object.entries(tasks))
          if (Date.now() - item.created > 600000) delete tasks[id];
        if (!tasks[key])
          tasks[key] = { id: crypto.randomUUID(), created: Date.now() };
        await chrome.storage.session.set({ jobsAnswerTasksV1: tasks });
        return tasks[key];
      });
      const request = async (method) => {
        for (let attempt = 0; ; attempt++) {
          const active = await serial(read);
          if (active.disabled || active.profileToken !== state.profileToken)
            throw Error("个人资料连接已改变，请重新开始");
          let response;
          try {
            response = await fetch(
              ORIGIN +
                "/api/manage/answer/jobs" +
                (method === "GET" ? "?id=" + encodeURIComponent(task.id) : ""),
              {
                method,
                credentials: "omit",
                headers: {
                  "X-Jobs-Protocol": "2",
                  "Content-Type": "application/json",
                  Authorization: "Bearer " + state.profileToken,
                },
                ...(method === "POST"
                  ? { body: JSON.stringify({ ...body, requestId: task.id }) }
                  : {}),
                signal: AbortSignal.timeout(15000),
              },
            );
          } catch (error) {
            if (attempt >= 2) throw error;
          }
          if (response) await checkRecoveryPause(response);
          // The same durable request ID fences provider work. Retry only transient
          // transport failures, never invalid answers or expired authentication.
          if (
            !response ||
            ([408, 429, 502, 503, 504].includes(response.status) && attempt < 2)
          ) {
            await new Promise((resolve) =>
              setTimeout(resolve, 500 * (attempt + 1)),
            );
            continue;
          }
          if (response.status === 404)
            throw Error("回答服务需要更新，已保留当前填写内容");
          return profileResult(
            response,
            state.profileToken,
            "Luna 请求失败，重试会继续同一任务",
          );
        }
      };
      let result = await request("POST");
      const deadline = Date.now() + 125000;
      while (result.state === "pending" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        result = await request("GET");
      }
      if (result.state === "completed") return result.result;
      if (result.state === "failed") {
        await serial(async () => {
          const tasks =
            /** @type {Record<string,import('./sync-types').AnswerTask>} */ (
              (await chrome.storage.session.get("jobsAnswerTasksV1"))
                .jobsAnswerTasksV1 || {}
            );
          if (tasks[key]?.id === task.id) {
            delete tasks[key];
            await chrome.storage.session.set({ jobsAnswerTasksV1: tasks });
          }
        });
        throw Error(result.result?.error || "Luna 请求失败");
      }
      if (result.state === "pending")
        throw Error("回答仍在处理中，请稍后重试以恢复同一任务");
      throw Error("Luna 返回的任务状态无效");
    }
    // Which listed job a page belongs to, for Profile binding of pages opened
    // outside the website. Read-only; the URL travels in the body, never a query.
    async function resolveJob(url, hint) {
      await ready;
      const state = await serial(read);
      if (!state.token || state.disabled) return null;
      const body = {
        url: cleanUrl(url),
        ...(/^[a-f0-9]{24}$/.test(hint || "") ? { website_job_id: hint } : {}),
      };
      const response = await fetch(ORIGIN + "/api/extension/resolve", {
        method: "POST",
        credentials: "omit",
        headers: {
          "X-Jobs-Protocol": "2",
          "Content-Type": "application/json",
          Authorization: "Bearer " + state.token,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      await checkRecoveryPause(response);
      return response.ok ? await response.json() : null;
    }
    /** @param {string} url @param {string} title @param {string=} hint
     * @param {(()=>Promise<string|undefined>)=} verify */
    async function reportJobTitle(url, title, hint, verify) {
      const epoch = JobsPrivateSession.epoch,
        observedAt = new Date().toISOString();
      await ready;
      const state = await serial(read);
      JobsPrivateSession.assertCurrent(epoch);
      if (state.disabled || !state.token)
        return { ok: false, reason: "disconnected" };
      const safeUrl = publicJobUrl(url);
      if (!safeUrl || !JobsJobMatch.same(safeUrl, url))
        return { ok: false, reason: "identity_unavailable" };
      if (verify) hint = await verify();
      JobsPrivateSession.assertCurrent(epoch);
      const body = {
        url: safeUrl,
        title,
        title_source: "existing_adapter",
        observed_at: observedAt,
        ...(/^[a-f0-9]{24}$/.test(hint || "") ? { website_job_id: hint } : {}),
      };
      const response = await fetch(ORIGIN + "/api/extension/job-title", {
        method: "POST",
        credentials: "omit",
        headers: {
          "X-Jobs-Protocol": "2",
          "Content-Type": "application/json",
          Authorization: "Bearer " + state.token,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      JobsPrivateSession.assertCurrent(epoch);
      await checkRecoveryPause(response);
      return response.ok
        ? await response.json()
        : { ok: false, reason: "not_accepted" };
    }
    JobsSync = {
      record,
      flush,
      profileRequest,
      managementRequest,
      migrationIdentity,
      migrationRequest,
      generateAnswer,
      resolveJob,
      reportJobTitle,
      ready,
    };
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (msg?.type === "jobs:job-action") {
        jobAction(msg, sender).then(reply, (error) =>
          reply({ error: error.message }),
        );
        return true;
      }
      if (
        ["jobs:availability-observe", "jobs:availability-restore"].includes(
          msg?.type,
        )
      ) {
        availability(msg, sender).then(reply, (error) =>
          reply({ error: error.message }),
        );
        return true;
      }
      if (
        ![
          "jobs:sync-status",
          "jobs:sync-pair-info",
          "jobs:sync-connect",
          "jobs:sync-disconnect",
        ].includes(msg?.type)
      )
        return;
      message(msg, sender).then(reply, (error) =>
        reply({ error: error.connectionMessage || "无法连接插件" }),
      );
      return true;
    });
    const schedule = () =>
      chrome.alarms.create("jobs-sync", { periodInMinutes: 1 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === "jobs-sync") void flush();
    });
    chrome.runtime.onStartup.addListener(() => {
      schedule();
      void flush();
    });
    chrome.runtime.onInstalled.addListener(() => {
      schedule();
      void flush();
    });
    schedule();
  })();
}
