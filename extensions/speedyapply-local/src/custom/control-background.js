import { JobsPrivateSession } from "./private-session.js";
import { checkRecoveryPause } from "./recovery-pause.js";
import { JobsTabProfiles } from "./tab-profiles.js";
import { JobsDiagnosticsBackground } from "./diagnostics-background.js";
import { JobsBrand } from "./brand.js";
import { JobsControlConfig } from "./control-config.js";
import { JobsSync } from "./sync.js";
export var JobsBrowserControl;
let initialized = false;
export function initializeControlBackground() {
  if (initialized) return;
  initialized = true;
  (() => {
    if (
      JobsControlConfig?.enabled !== true &&
      JobsControlConfig?.observe !== true
    )
      return;
    const KEY = "jobsBrowserControlV1",
      ORIGIN = JobsBrand.origin;
    // Keep these in step with browser_control.py. Real school/location lists
    // routinely exceed the former 12 KB / 200-option limits.
    const PAGE_BYTES = 512 * 1024,
      PAGES_BYTES = 6 * 1024 * 1024,
      OPTIONS_LIMIT = 5000;
    const RESULTS_BYTES = 7 * 1024 * 1024,
      BODY_BYTES = 8 * 1024 * 1024;
    /** @type {Promise<unknown>} */
    let queue = Promise.resolve(),
      running,
      timer;
    /** @template T @param {() => T|PromiseLike<T>} fn @returns {Promise<T>} */
    const serial = (fn) => {
      const task = queue.then(fn);
      queue = task.catch(() => {});
      return task;
    };
    const stateEpochs = new WeakMap();
    const read = async () => {
      const epoch = JobsPrivateSession.epoch;
      const value =
        /** @type {import('./worker-types.js').BrowserControlState} */ (
          (await chrome.storage.session.get(KEY))[KEY]
        ) || {
          sessionId: crypto.randomUUID(),
          frames: {},
          journal: {},
          results: [],
        };
      JobsPrivateSession.assertCurrent(epoch);
      stateEpochs.set(value, epoch);
      return value;
    };
    const write = (value) => {
      // Session storage is shared with all active applications. Transport limits
      // apply to an outgoing response, not to the unbounded full snapshots here.
      let retained = 0;
      for (const frame of Object.values(value.frames).sort(
        (a, b) => (b.snapshot?.observedAt || 0) - (a.snapshot?.observedAt || 0),
      )) {
        if (!frame.snapshot) continue;
        const size = bytes(frame.snapshot);
        if (retained + size > 1024 * 1024) delete frame.snapshot;
        else retained += size;
      }
      return JobsPrivateSession.commit(stateEpochs.get(value), {
        [KEY]: value,
      });
    };
    const frameKey = (tabId, frameId) => tabId + ":" + frameId;
    const bytes = (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength;
    /** @template T @param {Promise<T>} promise @param {number} ms @returns {Promise<T>} */
    function timeout(promise, ms) {
      let id;
      return Promise.race([
        promise,
        /** @type {Promise<never>} */ (
          new Promise((_, reject) => {
            id = setTimeout(() => reject(Error("Page did not respond")), ms);
          })
        ),
      ]).finally(() => clearTimeout(id));
    }
    function target(frame) {
      return frame.browserDocumentId
        ? { documentId: frame.browserDocumentId }
        : { frameId: frame.frameId };
    }
    async function register(message, sender) {
      if (
        sender.id !== chrome.runtime.id ||
        !Number.isInteger(sender.tab?.id) ||
        !Number.isInteger(sender.frameId) ||
        !sender.url?.startsWith("https://") ||
        typeof message.documentId !== "string"
      )
        throw Error("Invalid application page");
      await serial(async () => {
        const state = await read(),
          key = frameKey(sender.tab.id, sender.frameId);
        const previous = state.frames[key];
        state.frames[key] = {
          ...(previous?.documentId === message.documentId ? previous : {}),
          tabId: sender.tab.id,
          frameId: sender.frameId,
          documentId: message.documentId,
          browserDocumentId: sender.documentId,
          lifecycleId: message.lifecycleId,
        };
        await write(state);
      });
      return { ok: true };
    }
    function retireCommands(state, page) {
      for (const entry of Object.values(state.journal)) {
        try {
          const target = JSON.parse(entry.key).target;
          if (
            target?.tabId === page.tabId &&
            (page.frameId == null || target.frameId === page.frameId) &&
            (!page.documentId || target.documentId === page.documentId)
          )
            entry.key = "retired";
        } catch {}
      }
    }
    async function unregister(message, sender) {
      if (
        sender.id !== chrome.runtime.id ||
        !Number.isInteger(sender.tab?.id) ||
        !Number.isInteger(sender.frameId)
      )
        throw Error("Invalid application page");
      return serial(async () => {
        const state = await read(),
          key = frameKey(sender.tab.id, sender.frameId);
        const frame = state.frames[key];
        if (
          !frame ||
          frame.documentId !== message.documentId ||
          frame.browserDocumentId !== sender.documentId ||
          !frame.lifecycleId ||
          frame.lifecycleId !== message.lifecycleId
        )
          return { ok: false };
        delete state.frames[key];
        retireCommands(state, frame);
        await write(state);
        await JobsDiagnosticsBackground?.releasePage?.(
          sender.tab.id,
          sender.documentId,
        );
        if (
          !Object.values(state.frames).some(
            (row) => row.tabId === sender.tab.id,
          )
        )
          await JobsTabProfiles?.releasePage?.(sender.tab.id);
        return { ok: true };
      });
    }
    /** @param {import('./worker-types.js').BrowserTarget[]} requests */
    async function collect(requests = []) {
      const epoch = JobsPrivateSession.epoch;
      const state = await serial(read),
        pages = [],
        snapshots = [];
      const requested = new Set(
        requests.map(
          (row) => frameKey(row.tabId, row.frameId) + ":" + row.documentId,
        ),
      );
      // Read in parallel, bounded to the server's declared page limit. A missing
      // response retains its old timestamp; it is never presented as a fresh read.
      await Promise.all(
        Object.values(state.frames)
          .filter((frame) =>
            requested.has(
              frameKey(frame.tabId, frame.frameId) + ":" + frame.documentId,
            ),
          )
          .slice(0, 64)
          .map(async (frame) => {
            let snapshot = frame.snapshot;
            let tab;
            try {
              tab = await chrome.tabs.get(frame.tabId);
            } catch {
              await serial(async () => {
                const latest = await read(),
                  key = frameKey(frame.tabId, frame.frameId);
                if (latest.frames[key]?.documentId === frame.documentId) {
                  delete latest.frames[key];
                  await write(latest);
                }
              });
              return;
            }
            try {
              if (tab.discarded) {
                if (snapshot) pages.push(snapshot);
                return;
              }
              const reply = await timeout(
                chrome.tabs.sendMessage(
                  frame.tabId,
                  { type: "jobs:control-inspect" },
                  target(frame),
                ),
                2500,
              );
              if (!reply?.data || reply.data.documentId !== frame.documentId)
                return;
              snapshot = {
                ...reply.data,
                tabId: frame.tabId,
                frameId: frame.frameId,
              };
              const selected = /** @type {{id?: string}} */ (
                (await chrome.storage.session.get("profile_" + frame.tabId))[
                  "profile_" + frame.tabId
                ]
              );
              if (!snapshot.profileId || snapshot.profileId !== selected?.id) {
                snapshot.profileId = null;
                snapshot.actions = ["inspect"];
              }
              snapshots.push({ frame, snapshot });
            } catch {
              /* Offline/frozen pages remain visibly stale. */
            }
            if (snapshot) pages.push(snapshot);
          }),
      );
      // Large forms still appear in the overview; incomplete field lists can only
      // be inspected, never used to infer that advancing/submitting is safe.
      const latest = await serial(async () => {
        const value = await read();
        JobsPrivateSession.assertCurrent(epoch);
        for (const { frame, snapshot } of snapshots) {
          const current = value.frames[frameKey(frame.tabId, frame.frameId)];
          if (current?.documentId === frame.documentId)
            current.snapshot = snapshot;
        }
        if (snapshots.length) await write(value);
        return value;
      });
      const live = pages.filter(
        (page) =>
          latest.frames[frameKey(page.tabId, page.frameId)]?.documentId ===
          page.documentId,
      );
      const pageBudget = Math.min(
        PAGE_BYTES,
        Math.floor(PAGES_BYTES / Math.max(1, live.length)),
      );
      let size = 0;
      return live.map((page) => {
        const value = structuredClone(page);
        // Events themselves can exceed the page budget (especially UTF-8 text).
        // Diagnostic truncation does not remove the complete actionable form.
        if (bytes(value) > pageBudget && value.events?.length) {
          const compact = () => {
            while (bytes(value) > pageBudget && value.events.length > 1) {
              const noise = value.events.findIndex(
                (event) =>
                  !/^(answer_decision$|answer_trace_truncated$|auto_|build_info$|field_(?:structure|state_changed|value_lost|detached|replaced)$|phase$|adapter_|action_failed$|navigation_observed$)/.test(
                    event.type,
                  ),
              );
              const activity = value.events.findIndex(
                (event) =>
                  !/^answer_(?:decision|trace_truncated)$/.test(event.type),
              );
              value.events.splice(
                noise >= 0 ? noise : activity >= 0 ? activity : 0,
                1,
              );
            }
          };
          // Reserve useful recent evidence before dropping the field inventory.
          if (bytes({ ...value, fields: [] }) > pageBudget) {
            const fields = value.fields;
            value.fields = [];
            compact();
            value.fields = fields;
          }
          compact();
        }
        let truncated = false;
        if (
          bytes(value) > pageBudget ||
          value.fields?.some(
            (field) => (field.options?.length || 0) > OPTIONS_LIMIT,
          )
        ) {
          truncated = true;
          // A huge unrelated school list must not disable a small current AI
          // review. Retain the ENTIRE card and its exact choices, never a subset
          // of review items, and expose no ordinary navigation on a reduced form.
          const reviewIds = new Set(
            value.review?.items.map((item) => item.fieldId) || [],
          );
          const reviewFields = value.fields.filter((field) =>
            reviewIds.has(field.id),
          );
          const completeReview =
            value.review?.ready &&
            reviewIds.size > 0 &&
            [...reviewIds].every(
              (id) => id && reviewFields.some((field) => field.id === id),
            ) &&
            reviewFields.every(
              (field) => (field.options?.length || 0) <= OPTIONS_LIMIT,
            );
          if (completeReview) {
            value.fields = reviewFields;
            value.actions = value.actions.filter((action) =>
              ["inspect", "answer_review", "confirm_review"].includes(action),
            );
          } else {
            value.fields = value.fields.map(({ options, ...field }) => field);
            value.actions = ["inspect"];
          }
        }
        if (bytes(value) > pageBudget || size + bytes(value) > PAGES_BYTES) {
          value.fields = [];
          delete value.review;
          value.actions = ["inspect"];
          truncated = true;
        }
        if (truncated) {
          const event = {
            at: Date.now(),
            type: "remote_snapshot_truncated",
            detail: value.actions.includes("confirm_review")
              ? "Large form: complete current review retained; other fields omitted"
              : "Form exceeds remote budget; inspect only",
          };
          value.events = [...(value.events || []).slice(-49), event];
          while (bytes(value) > pageBudget && value.events.length > 1)
            value.events.shift();
        }
        size += bytes(value);
        return value;
      });
    }
    /** @param {import('./worker-types.js').BrowserCommand} command */
    async function dispatch(command) {
      const epoch = JobsPrivateSession.epoch;
      if (JobsControlConfig?.enabled !== true)
        throw Error("Remote execution is disabled");
      const key = JSON.stringify(command);
      const prepared = await serial(async () => {
        const state = await read(),
          previous = state.journal[command.id];
        if (previous) {
          if (previous.key !== key) throw Error("Command ID reused");
          return { result: previous.result };
        }
        if (
          command.sessionId !== state.sessionId ||
          !Number.isFinite(command.expiresAt) ||
          command.expiresAt <= Date.now()
        )
          throw Error("Command expired or browser restarted");
        const frame =
          state.frames[frameKey(command.target.tabId, command.target.frameId)];
        if (!frame || frame.documentId !== command.target.documentId)
          throw Error("Page was replaced");
        for (const [id, entry] of Object.entries(state.journal)) {
          let expires = entry.expiresAt;
          if (!Number.isFinite(expires))
            try {
              expires = JSON.parse(entry.key).expiresAt;
            } catch {}
          // Only retire acknowledged commands after their delivery window closes.
          // Expiry is checked above even after this tombstone is removed; a lost
          // result stays journalled and is never replayed to make room.
          if (
            entry.reported &&
            Number.isFinite(expires) &&
            expires <= Date.now()
          )
            delete state.journal[id];
        }
        if (Object.keys(state.journal).length >= 500)
          throw Error("Supervised session command limit reached");
        const result =
          /** @type {import('./worker-types.js').CommandResult} */ ({
            id: command.id,
            state: "unknown",
            error: "Delivery interrupted; do not retry automatically",
          });
        state.journal[command.id] = {
          key,
          result,
          expiresAt: command.expiresAt,
        };
        await write(state);
        return { frame };
      });
      JobsPrivateSession.assertCurrent(epoch);
      if (prepared.result) return prepared.result;
      let result;
      try {
        const remaining = command.expiresAt - Date.now();
        if (remaining <= 0)
          result = {
            id: command.id,
            state: "failed",
            error: "Command expired before delivery",
          };
        else {
          // Content stops writes at the command deadline. A batch may contain
          // several slow controls and fresh Profile checks; keep its receipt
          // channel alive for that same bounded window plus transport grace.
          // The server caps TTL at 60 seconds. A missing receipt stays unknown
          // and is never retried, even if it arrives after this maximum wait.
          result = await timeout(
            chrome.tabs.sendMessage(
              prepared.frame.tabId,
              { type: "jobs:control-execute", command },
              target(prepared.frame),
            ),
            Math.min(remaining, 60000) + 2000,
          );
        }
        if (
          result?.id !== command.id ||
          !["completed", "failed", "unknown"].includes(result.state)
        )
          throw Error("Invalid page response");
      } catch {
        result = {
          id: command.id,
          state: "unknown",
          error: "Page did not confirm execution; inspect before continuing",
        };
      }
      await serial(async () => {
        const state = await read();
        JobsPrivateSession.assertCurrent(epoch);
        state.journal[command.id].result = result;
        await write(state);
      });
      return result;
    }
    async function run() {
      const epoch = JobsPrivateSession.epoch;
      await JobsSync.ready;
      const connection =
        /** @type {import('./worker-types.js').PrivateConnectionState|undefined} */ (
          (await chrome.storage.local.get("jobsSyncV1")).jobsSyncV1
        );
      if (!connection?.profileToken || connection.disabled) return;
      await serial(async () => {
        const state = await read();
        // Recover outcomes across worker interruption, never the original action.
        for (const entry of Object.values(state.journal))
          if (
            !entry.reported &&
            !state.results.some((result) => result.id === entry.result.id)
          )
            state.results.push(entry.result);
        await write(state);
      });
      const requested = await serial(async () => {
        const state = await read();
        return state.snapshotRequests || [];
      });
      const pages = await collect(requested);
      const state = await serial(async () => {
        const value = await read();
        await write(value);
        return value;
      });
      const inventory = Object.values(state.frames)
        .slice(0, 64)
        .map(({ tabId, frameId, documentId }) => ({
          tabId,
          frameId,
          documentId,
        }));
      const payload = {
        protocolVersion: 2,
        sessionId: state.sessionId,
        inventory,
        pages: [],
        results: [],
      };
      for (const page of pages) {
        payload.pages.push(page);
        if (bytes(payload) > PAGES_BYTES + 4096) {
          payload.pages.pop();
          break;
        }
      }
      for (const result of JobsControlConfig?.enabled === true
        ? state.results.slice(0, 64)
        : []) {
        payload.results.push(result);
        if (bytes(payload) > RESULTS_BYTES) {
          payload.results.pop();
          break;
        }
      }
      const sent = payload.results;
      JobsPrivateSession.assertCurrent(epoch);
      const response = await fetch(ORIGIN + "/api/extension/control", {
        method: "POST",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          "X-Jobs-Protocol": "2",
          Authorization: "Bearer " + connection.profileToken,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      await checkRecoveryPause(response);
      if (!response.ok)
        throw Error("Control endpoint unavailable (" + response.status + ")");
      const data = await response.json();
      JobsPrivateSession.assertCurrent(epoch);
      if (data.enabled !== true || !Array.isArray(data.commands))
        throw Error("Server control is disabled");
      const currentConnection =
        /** @type {import('./worker-types.js').PrivateConnectionState|undefined} */ (
          (await chrome.storage.local.get("jobsSyncV1")).jobsSyncV1
        );
      if (
        currentConnection?.disabled ||
        currentConnection?.profileToken !== connection.profileToken
      )
        return;
      await serial(async () => {
        const value = await read();
        value.lastExchangeAt = Date.now();
        const ids = new Set(sent.map((result) => result.id));
        value.snapshotRequests = (
          Array.isArray(data.snapshotRequests) ? data.snapshotRequests : []
        )
          .filter(
            (request) =>
              value.frames[frameKey(request.tabId, request.frameId)]
                ?.documentId === request.documentId,
          )
          .slice(0, 64);
        value.results = value.results.filter((result) => !ids.has(result.id));
        for (const id of ids)
          if (value.journal[id]) value.journal[id].reported = true;
        await write(value);
      });
      if (JobsControlConfig?.enabled !== true) return;
      // Different tabs may progress together; never mutate one tab concurrently.
      const groups = new Map();
      for (const command of data.commands) {
        const id = command.target?.tabId;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(command);
      }
      const batches = [...groups.values()];
      const worker = async () => {
        for (let batch; (batch = batches.shift());)
          for (const command of batch) {
            let result;
            try {
              JobsPrivateSession.assertCurrent(epoch);
              result = await dispatch(command);
            } catch (error) {
              result = {
                id: command.id,
                state: "failed",
                error: error.message,
              };
            }
            await serial(async () => {
              const value = await read();
              value.results = value.results.filter(
                (item) => item.id !== result.id,
              );
              JobsPrivateSession.assertCurrent(epoch);
              value.results.push(result);
              await write(value);
            });
          }
      };
      await Promise.all(
        Array.from({ length: Math.min(3, batches.length) }, worker),
      );
    }
    function tick() {
      if (running) return running;
      running = run()
        .then(() =>
          serial(async () => {
            const state = await read();
            delete state.error;
            await write(state);
          }),
        )
        .catch((error) =>
          serial(async () => {
            const state = await read();
            state.error = String(error.message || error).slice(0, 500);
            await write(state);
          }).catch(() => {}),
        )
        .finally(() => {
          running = null;
        });
      return running;
    }
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (
        !["jobs:control-register", "jobs:control-unregister"].includes(
          message?.type,
        )
      )
        return;
      (message.type === "jobs:control-register" ? register : unregister)(
        message,
        sender,
      ).then(reply, (error) => reply({ error: error.message }));
      return true;
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      void serial(async () => {
        const state = await read();
        for (const [key, frame] of Object.entries(state.frames))
          if (frame.tabId === tabId) {
            delete state.frames[key];
            await JobsDiagnosticsBackground?.releasePage?.(
              tabId,
              frame.browserDocumentId,
            );
          }
        retireCommands(state, { tabId });
        await write(state);
      }).catch(() => {});
    });
    chrome.tabs.onUpdated.addListener((tabId, change) => {
      if (change.status !== "loading") return;
      void serial(async () => {
        const state = await read();
        for (const [key, frame] of Object.entries(state.frames))
          if (frame.tabId === tabId) {
            delete state.frames[key];
            await JobsDiagnosticsBackground?.releasePage?.(
              tabId,
              frame.browserDocumentId,
            );
          }
        retireCommands(state, { tabId });
        await write(state);
      }).catch(() => {});
    });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === "jobs-control") void tick();
    });
    chrome.alarms.create("jobs-control", { periodInMinutes: 0.5 });
    JobsBrowserControl = { tick };
  })();
}
