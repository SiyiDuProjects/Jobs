import { JobsPrivateSession } from "./private-session.js";
import { JobsBrand } from "./brand.js";
import { JobsStorageUpgrade } from "./storage-upgrade.js";
import { JobsJobMatch } from "./job-match.js";
import { JobsManagementModel } from "./management-model.js";
import { JobsManagementSync } from "./management-sync.js";
import { JobsSync } from "./sync.js";
/** @typedef {import('../../../../services/jobs-radar/web/src/manage/profile-types').Profile} Profile */
/** @typedef {{id:string, profile:Profile, last_sync?:string}} ProfileRecord */
/** @typedef {{id:string, profile:Profile, profileName:string, selectionSource:string, timestamp:string, lastSync?:string, resumeRef?:string}} TabProfile */
/** @typedef {{websiteJobId?:string, at:number, jobKey?:string}} TabBinding */
/** @typedef {{jobsProfilesList?:Array<{id:string,profileName:string,last_sync?:string}>, jobsKindProfiles?:Partial<Record<'intern'|'newgrad',string>>,jobsManualProfileDefault?:{id:string,at:number}}} ProfileState */
export var JobsTabProfiles;
let initialized = false;
export function initializeTabProfiles() {
  if (initialized) return;
  initialized = true;
  (() => {
    // Website links outlive an extension reload (local, not session storage) and
    // are indexed by both the exact link and its job identity, so a redirect or
    // application step of the same posting still finds the employment kind.
    const ORIGIN = JobsBrand.origin,
      RECOVERY = "jobsTabProfileRecoveryV2",
      LINKS = "jobsWebsiteLinksV2",
      LINK_TTL = 14 * 86400000;
    const MANUAL_DEFAULT = "jobsManualProfileDefault";
    const profileData = async (keys) =>
      /** @type {ProfileState} */ ({
        ...(await chrome.storage.local.get(
          keys.filter((key) => !["jobsProfilesList"].includes(key)),
        )),
        ...(await chrome.storage.session.get(
          keys.filter((key) => ["jobsProfilesList"].includes(key)),
        )),
      });
    const resolved = new Map();
    const recordEpoch = new WeakMap();
    let queue = Promise.resolve();
    const tabQueues = new Map();
    const tabRevisions = new Map();
    const operations = new Map();
    function assertTab(id) {
      const operation = operations.get(id);
      if (!operation) return;
      JobsPrivateSession.assertCurrent(operation.epoch);
      if ((tabRevisions.get(id) || 0) !== operation.revision)
        throw Error("申请标签页已关闭，请重新打开岗位");
    }
    const serial = (fn) => {
      const task = queue.then(fn);
      queue = task.catch(() => {});
      return task;
    };
    // Multiple frames ask for configuration at once. Their first binding and a
    // manual override must commit in order, without delaying other tabs.
    const inTab = (id, fn) => {
      const operation = {
        epoch: JobsPrivateSession.epoch,
        revision: tabRevisions.get(id) || 0,
        verifiedRecords: new WeakSet(),
        freshlyBound: false,
      };
      const task = (tabQueues.get(id) || Promise.resolve()).then(async () => {
        operations.set(id, operation);
        try {
          assertTab(id);
          const value = await fn();
          assertTab(id);
          return value;
        } finally {
          if (operations.get(id) === operation) operations.delete(id);
        }
      });
      const settled = task
        .catch(() => {})
        .finally(() => {
          if (tabQueues.get(id) === settled) tabQueues.delete(id);
        });
      tabQueues.set(id, settled);
      return task;
    };
    const safeUrl = (value) => {
      const u = new URL(value);
      if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
        throw Error("Invalid job URL");
      return u.href;
    };
    const urlKey = async (value) => {
      const u = new URL(value);
      // Unknown query keys and hash routes can identify different jobs. Keep
      // them in the identity, but persist only a digest, never login tokens.
      for (const k of [...u.searchParams.keys()])
        if (/^(utm_.+|gclid|fbclid|gh_src)$/i.test(k)) u.searchParams.delete(k);
      u.searchParams.sort();
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(u.href),
      );
      return (
        "sha256:" +
        Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("")
      );
    };
    const jobDigest = async (value) => {
      const key = JobsJobMatch?.key(value);
      if (!key) return null;
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(key),
      );
      return (
        "job:" +
        Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("")
      );
    };
    const linkKeys = async (value) =>
      [await urlKey(value), await jobDigest(value)].filter(Boolean);
    async function selected(id) {
      return /** @type {TabProfile | undefined} */ (
        (await JobsPrivateSession.readTab(id))["profile_" + id]
      );
    }
    async function metadata(id) {
      return /** @type {TabBinding | undefined} */ (
        (await chrome.storage.session.get("jobsTabBinding:" + id))[
          "jobsTabBinding:" + id
        ]
      );
    }
    /** @param {number} id @param {ProfileRecord} record */
    async function bind(
      id,
      record,
      websiteJobId,
      selectionSource = "default",
      url = undefined,
    ) {
      await JobsStorageUpgrade.assertReady();
      const value = {
        id: record.id,
        profileName: record.profile.profileName,
        profile: record.profile,
        selectionSource,
        timestamp: new Date().toISOString(),
        ...(record.last_sync ? { lastSync: record.last_sync } : {}),
      };
      const prior = !url ? await metadata(id) : null;
      // Starting a fresh filling run updates the Profile version, not the job
      // whose original identity permits a later ATS confirmation redirect.
      const jobKey = url
        ? await jobDigest(url)
        : prior?.websiteJobId === websiteJobId
          ? prior?.jobKey
          : null;
      assertTab(id);
      await JobsPrivateSession.commit(
        operations.get(id)?.epoch ?? JobsPrivateSession.epoch,
        {
          ["profile_" + id]: value,
          ["jobsResponseTab:" + id]: record.id,
          ["jobsTabBinding:" + id]: {
            websiteJobId,
            at: Date.now(),
            ...(jobKey ? { jobKey } : {}),
          },
        },
      );
      const synchronized = JobsManagementSync.forProfile
        ? await JobsManagementSync.forProfile(record.id)
        : await JobsManagementSync.sync?.();
      assertTab(id);
      if (synchronized?.ok === false)
        throw Error("无法获取已保存回答，已暂停填写；请检查连接后重试");
      const operation = operations.get(id);
      if (operation)
        operation.freshlyBound = operation.verifiedRecords.has(record);
      return (await selected(id)) || value;
    }
    async function kindRecord(kind, operation) {
      let data = await profileData(["jobsProfilesList", "jobsKindProfiles"]);
      let map = JobsManagementModel.mappings(
        data.jobsProfilesList || [],
        data.jobsKindProfiles,
      );
      if (!map[kind]) {
        await JobsManagementSync.profiles();
        data = await profileData(["jobsProfilesList", "jobsKindProfiles"]);
        map = JobsManagementModel.mappings(
          data.jobsProfilesList || [],
          data.jobsKindProfiles,
        );
      }
      return map[kind] ? latest(map[kind], operation) : null;
    }
    // Pages opened outside the website (agent tools, bookmarks, after an
    // extension reload) ask the server which listed job they belong to. One
    // lookup per job identity; an offline server simply leaves them unresolved.
    async function remoteJob(url, hint) {
      const epoch = JobsPrivateSession.epoch;
      const key = await jobDigest(url);
      if (!key || !JobsSync?.resolveJob) return null;
      const cached = resolved.get(key);
      if (cached?.epoch === epoch && Date.now() - cached.at < 600000)
        return cached.value;
      let value = null;
      try {
        const reply = await JobsSync.resolveJob(url, hint);
        if (
          reply?.state === "matched" &&
          /^[a-f0-9]{24}$/.test(reply.job_id || "")
        )
          value = reply;
      } catch {}
      // A failed/offline lookup must not hide a later match for ten minutes.
      JobsPrivateSession.assertCurrent(epoch);
      if (value) resolved.set(key, { at: Date.now(), value, epoch });
      return value;
    }
    async function rememberResolution(url, value, epoch) {
      if (
        value?.state !== "matched" ||
        !/^[a-f0-9]{24}$/.test(value.job_id || "") ||
        !Array.isArray(value.kinds)
      )
        return;
      const key = await jobDigest(url);
      JobsPrivateSession.assertCurrent(epoch);
      if (key) resolved.set(key, { at: Date.now(), value, epoch });
    }
    async function bindResolved(tab, url, hint) {
      const job = await remoteJob(url, hint);
      // A posting listed in both pools is a real ambiguity; keep the fallback.
      if (job?.kinds?.length !== 1) return null;
      const record = await kindRecord(job.kinds[0], operations.get(tab.id));
      if (!record?.profile) return null;
      const value = await bind(tab.id, record, job.job_id, "resolved", url);
      await remember(tab, value, job.job_id);
      return value;
    }
    async function remember(tab, value, websiteJobId) {
      if (!tab?.url || !/^https?:/.test(tab.url)) return;
      await serial(async () => {
        const saved =
          (await chrome.storage.local.get(RECOVERY))[RECOVERY] || {};
        const old = saved[tab.id];
        // Chrome can reuse numeric tab IDs after a browser restart. Only extend
        // the URL history belonging to this exact binding snapshot.
        const same =
          old?.timestamp === value.timestamp &&
          old?.id === value.id &&
          old?.websiteJobId === websiteJobId;
        const urls = [
          ...new Set([...(same ? old.urls || [] : []), await urlKey(tab.url)]),
        ].slice(-20);
        const { profile, ...identity } = value;
        saved[tab.id] = { ...identity, websiteJobId, urls, at: Date.now() };
        // Keep recovery identities for seven days; full facts are never persisted.
        for (const [key, row] of Object.entries(saved)) {
          if (Date.now() - row.at > 7 * 86400000) delete saved[key];
          else delete row.profile;
        }
        await chrome.storage.local.set({ [RECOVERY]: saved });
      });
    }
    async function ensure(sender, bindDefault = true) {
      await JobsStorageUpgrade.assertReady();
      const id = sender.tab?.id;
      if (id === undefined) return null;
      return inTab(id, () => ensureTab(sender, bindDefault));
    }
    async function ensureTab(sender, bindDefault) {
      await JobsStorageUpgrade.assertReady();
      const id = sender.tab.id;
      const operation = operations.get(id);
      let value = await selected(id);
      const tab = await chrome.tabs.get(id);
      if (!tab) throw Error("申请标签页已关闭，请重新打开岗位");
      // Read the website's optional metadata at the destination. Navigation is
      // entirely native and never waits for this Profile lookup.
      const url =
        tab.url === "about:blank" ? tab.pendingUrl : tab.url || tab.pendingUrl;
      let website = await websiteLink(url);
      const authoritative = await remoteJob(url, website?.jobId);
      if (authoritative)
        website = {
          jobId: authoritative.job_id,
          kind:
            authoritative.kinds.length === 1 ? authoritative.kinds[0] : null,
          ambiguous: authoritative.kinds.length !== 1,
        };
      else website = null;
      const binding = value ? await metadata(id) : null;
      // A tab outlives a job. Preserve manual choices and login/step redirects
      // within the same job, but an explicitly different job starts a new binding.
      if (value && (!website || binding?.websiteJobId === website.jobId)) {
        // Another listed posting opened in this tab without the website (not a
        // login or step page of the bound one) gets its own pool when filling.
        if (
          bindDefault &&
          !website &&
          value.selectionSource !== "manual" &&
          binding?.jobKey
        ) {
          const key = await jobDigest(url);
          if (key && key !== binding.jobKey) {
            const job = await remoteJob(url, binding.websiteJobId);
            if (job && job.job_id !== binding.websiteJobId)
              return (
                (await bindResolved(tab, url, binding.websiteJobId)) || value
              );
          }
        }
        return value;
      }
      if (website) {
        // An explicit choice made in this tab for this very job survives a
        // browser restart; the website's pool is the default for everything else.
        const manual = ((await recovered(tab, sender)) || []).filter(
          (row) =>
            row.selectionSource === "manual" &&
            row.websiteJobId === website.jobId,
        );
        const chosen =
          new Set(manual.map((row) => row.id)).size === 1
            ? await latest(manual[0].id, operation)
            : null;
        const manualDefault = await profileData([MANUAL_DEFAULT]);
        const record =
          chosen ||
          (website.ambiguous
            ? manualDefault[MANUAL_DEFAULT]?.id
              ? await latest(manualDefault[MANUAL_DEFAULT].id, operation)
              : null
            : await kindRecord(website.kind, operation));
        if (!record?.profile)
          throw Error("未找到岗位对应的 Profile，请选择资料后再填写");
        value = await bind(
          id,
          record,
          website.jobId,
          chosen || website.ambiguous ? "manual" : "resolved",
          url,
        );
        await remember(tab, value, website.jobId);
        return value;
      }
      value = await inherit(tab);
      if (value) return value;
      const data = await profileData([MANUAL_DEFAULT]);
      const recovery = await recovered(tab, sender);
      if (!recovery) return null;
      if (recovery.length) {
        const identities = new Set(
          recovery.map((r) => r.id + ":" + (r.websiteJobId || "")),
        );
        if (identities.size !== 1)
          throw Error(
            "恢复的申请页有多个资料身份，请在本页确认 Profile 后再填写",
          );
        const record = await latest(recovery[0].id, operation);
        value = await bind(
          id,
          record,
          recovery[0].websiteJobId,
          recovery[0].selectionSource || "restored",
          url,
        );
      } else if (bindDefault) {
        value = await bindResolved(tab, url);
        if (value) return value;
        // Unknown to the website and the server: the Profile the owner last chose
        // by hand, never whichever job tab happened to be viewed last.
        const manual = data[MANUAL_DEFAULT]?.id
          ? await latest(data[MANUAL_DEFAULT].id, operation)
          : null;
        if (manual?.profile)
          value = await bind(id, manual, undefined, "default", url);
      }
      if (value) await remember(tab, value, recovery[0]?.websiteJobId);
      return value;
    }
    // Browser-restored tabs: the journal of URLs each binding visited (digests only).
    async function recovered(tab, sender) {
      let key;
      try {
        key = await urlKey(tab.url || sender.url);
      } catch {
        return null;
      }
      const rows = [];
      for (const row of Object.values(
        (await chrome.storage.local.get(RECOVERY))[RECOVERY] || {},
      )) {
        if (Date.now() - row.at >= 7 * 86400000 || !Array.isArray(row.urls))
          continue;
        for (const stored of row.urls) {
          // Read existing journals too, without their old query-stripping rule.
          let match = stored === key;
          if (!match && /^https?:/.test(stored))
            try {
              match = (await urlKey(stored)) === key;
            } catch {}
          if (match) {
            rows.push(row);
            break;
          }
        }
      }
      return rows;
    }
    async function inherit(tab, snapshot = undefined) {
      const id = tab.id;
      if (tab.openerTabId !== undefined && tab.openerTabId !== id) {
        // The opener may itself be a browser-restored tab whose content script
        // has not run yet. Recover its snapshot before inheriting it.
        const saved =
          snapshot || (await JobsPrivateSession.readTab(tab.openerTabId));
        let parent = /** @type {TabProfile | undefined} */ (
            saved["profile_" + tab.openerTabId]
          ),
          meta = /** @type {TabBinding | undefined} */ (
            saved["jobsTabBinding:" + tab.openerTabId]
          );
        if (!parent) {
          const opener = await chrome.tabs
            .get(tab.openerTabId)
            .catch(() => null);
          if (opener) {
            parent = await ensure({ tab: opener, url: opener.url }, false);
            meta = await metadata(tab.openerTabId);
          }
        }
        if (parent) {
          const value = await bind(
            id,
            { id: parent.id, profile: parent.profile },
            meta?.websiteJobId,
            parent.selectionSource || "inherited",
            tab.url || tab.pendingUrl,
          );
          await remember(tab, value, meta?.websiteJobId);
          return value;
        }
      }
      return null;
    }
    async function register(msg, sender) {
      if (
        sender.id !== chrome.runtime.id ||
        new URL(sender.url).origin !== ORIGIN ||
        sender.frameId > 0
      )
        throw Error("Invalid website");
      if (!Array.isArray(msg.links) || msg.links.length > 2000)
        throw Error("Invalid website links");
      await serial(async () => {
        const links = (await chrome.storage.local.get(LINKS))[LINKS] || {};
        for (const [key, row] of Object.entries(links))
          if (Date.now() - row.at > LINK_TTL) delete links[key];
        for (const row of msg.links) {
          if (
            !["intern", "newgrad"].includes(row.kind) ||
            !/^[a-f0-9]{24}$/.test(row.jobId || "")
          )
            continue;
          let keys;
          try {
            keys = await linkKeys(safeUrl(row.url));
          } catch {
            continue;
          }
          for (const key of keys) {
            const old = links[key];
            // The same posting listed in both pools needs a manual choice. A
            // repeat of the same job/kind (every board refresh) stays unambiguous.
            const conflict = !!old && (old.ambiguous || old.kind !== row.kind);
            links[key] = {
              jobId: row.jobId,
              kind: row.kind,
              ambiguous: conflict,
              at: Date.now(),
            };
          }
        }
        const recent = Object.entries(links)
          .sort((a, b) => b[1].at - a[1].at)
          .slice(0, 8000);
        await chrome.storage.local.set({ [LINKS]: Object.fromEntries(recent) });
      });
      // Cache refresh is independent: an offline server cannot break links.
      void JobsManagementSync.profiles().catch(() => {});
      return { ok: true };
    }
    async function websiteLink(url) {
      let keys;
      try {
        keys = await linkKeys(safeUrl(url));
      } catch {
        return null;
      }
      await queue;
      const links = (await chrome.storage.local.get(LINKS))[LINKS] || {};
      // The exact link is the strongest evidence; the job identity covers its
      // redirects, locale prefixes and application steps.
      const row = keys
        .map((key) => links[key])
        .find((row) => row && Date.now() - row.at <= LINK_TTL);
      if (!row) return null;
      return row;
    }
    const same = (a, b) => JobsManagementModel.same(a, b);
    async function latest(id, operation = undefined) {
      const epoch = JobsPrivateSession.epoch;
      let record;
      try {
        record = await JobsSync.profileRequest({
          path: "/api/extension/profiles/" + encodeURIComponent(id),
          method: "GET",
        });
      } catch {
        throw Error("无法获取最新 Profile，已暂停填写；请检查连接后重试");
      }
      JobsPrivateSession.assertCurrent(epoch);
      if (record?.id !== id || !record.profile || !record.last_sync)
        throw Error("本页 Profile 已删除或不可用，请重新选择资料");
      recordEpoch.set(record, epoch);
      operation?.verifiedRecords.add(record);
      return record;
    }
    async function fresh(sender, { begin = false, remote = false } = {}) {
      await JobsStorageUpgrade.assertReady();
      const id = sender.tab?.id;
      if (id === undefined) return null;
      return inTab(id, async () => {
        const value = await ensureTab(sender, begin);
        if (!value) return null;
        // Only a record fetched and synchronized in this operation is fresh.
        // Inheriting a parent's binding still requires a current server read.
        if (begin && operations.get(id)?.freshlyBound) return value;
        const readLatest = async () => {
          try {
            return await latest(value.id, operations.get(id));
          } catch (error) {
            const { lastSync, ...unverified } = value;
            assertTab(id);
            await JobsPrivateSession.commit(
              operations.get(id)?.epoch ?? JobsPrivateSession.epoch,
              { ["profile_" + id]: unverified },
            );
            throw error;
          }
        };
        if (begin) {
          const record = await readLatest();
          const meta = await metadata(id);
          const current = await bind(
            id,
            record,
            meta?.websiteJobId,
            value.selectionSource,
          );
          await remember(
            await chrome.tabs.get(id),
            current,
            meta?.websiteJobId,
          );
          return current;
        }
        if (!value.lastSync)
          throw Error("本页资料尚未核对最新版本，请重新开始填写");
        const list =
          (await profileData(["jobsProfilesList"])).jobsProfilesList || [];
        const summary = list.find((row) => row.id === value.id);
        const record = remote ? await readLatest() : null;
        if (
          (record && !same(record.profile, value.profile)) ||
          (!remote && summary?.last_sync > value.lastSync)
        )
          throw Error(
            "Profile 已更新，已停止使用旧答案；已填内容保留，请重新开始填写",
          );
        return value;
      });
    }
    async function context(sender, message = {}) {
      const value = await fresh(sender, {
        begin: message.refresh === true,
        remote: message.verify === true,
      });
      return value
        ? {
            tabId: sender.tab.id,
            id: value.id,
            profile: value.profile,
            profileName: value.profileName,
            revision: value.lastSync,
            resumeRef: value.resumeRef,
          }
        : null;
    }
    async function select(id, record, expectedUrl) {
      JobsPrivateSession.assertCurrent(
        recordEpoch.get(record) ?? JobsPrivateSession.epoch,
      );
      return inTab(id, async () => {
        const tab = await chrome.tabs.get(id);
        if (!tab) throw Error("申请标签页已关闭，请重新打开岗位");
        if (expectedUrl !== undefined && tab.url !== expectedUrl)
          throw Error("页面已跳转，请重新打开小窗再切换");
        const meta = await metadata(id);
        const value = await bind(
          id,
          record,
          meta?.websiteJobId,
          "manual",
          tab.url,
        );
        await remember(tab, value, meta?.websiteJobId);
        return value;
      });
    }
    const candidate = async (tab) =>
      !!(
        (await selected(tab.id)) ||
        (await websiteLink(
          tab.url === "about:blank"
            ? tab.pendingUrl
            : tab.url || tab.pendingUrl,
        ).catch(() => null))
      );
    async function releasePage(id) {
      tabRevisions.set(id, (tabRevisions.get(id) || 0) + 1);
      await JobsPrivateSession.commit(JobsPrivateSession.epoch, {}, [
        "profile_" + id,
      ]);
      await JobsManagementSync.release?.();
    }
    JobsTabProfiles = {
      rememberResolution,
      ensure,
      context,
      selected,
      bind,
      select,
      candidate,
      releasePage,
      verify: (sender) => fresh(sender, { remote: true }),
    };
    async function popup(msg, sender) {
      if (
        sender.id !== chrome.runtime.id ||
        sender.tab ||
        sender.url !== chrome.runtime.getURL("popup.html")
      )
        throw Error("Invalid popup");
      if (!["read", "select"].includes(msg.action))
        throw Error("Invalid profile action");
      await JobsStorageUpgrade.assertReady();
      const tab = Number.isInteger(msg.tabId)
        ? await chrome.tabs.get(msg.tabId).catch(() => null)
        : null;
      if (msg.action === "select") {
        if (!["intern", "newgrad"].includes(msg.kind))
          throw Error("Invalid profile choice");
        if (tab && tab.url !== msg.url)
          throw Error("页面已跳转，请重新打开小窗再切换");
        await JobsManagementSync.profiles();
      }
      // Profile matching belongs to the job link, even when this site has no
      // filling adapter or the extension was reloaded after the tab opened.
      // Reuse the shared resolver without starting a fill or binding a default.
      if (
        tab &&
        /^https?:/.test(tab.url || "") &&
        new URL(tab.url).origin !== ORIGIN
      )
        await ensure({ tab }, false);
      const data = await profileData(["jobsProfilesList", "jobsKindProfiles"]);
      const map = JobsManagementModel.mappings(
        data.jobsProfilesList || [],
        data.jobsKindProfiles,
      );
      if (msg.action === "select") {
        const chosenId = map[msg.kind];
        if (!chosenId) throw Error("未找到对应档案，请到投递管理检查");
        // Unknown pages fall back to this explicit choice, not the last viewed tab.
        await chrome.storage.local.set({
          [MANUAL_DEFAULT]: { id: chosenId, at: Date.now() },
        });
        // Only an already-bound application needs a new filling run. Changing
        // the global default on Jobs or a browser settings page needs no reload.
        if (
          tab &&
          ((await selected(tab.id)) ||
            (await websiteLink(tab.url).catch(() => true)))
        ) {
          await select(tab.id, await latest(chosenId), msg.url);
        }
      }
      const current = tab ? await selected(tab.id) : null;
      const fallback = /** @type {{id:string,at:number} | undefined} */ (
        (await chrome.storage.local.get(MANUAL_DEFAULT))[MANUAL_DEFAULT]
      );
      const currentId = current?.id || fallback?.id;
      const kind = Object.keys(map).find((kind) => map[kind] === currentId);
      const source = current?.selectionSource || "manual";
      return {
        available: true,
        bound: !!current,
        tabId: tab?.id,
        url: tab?.url,
        kind: kind || null,
        profileName:
          data.jobsProfilesList?.find((row) => row.id === currentId)
            ?.profileName || "",
        source,
        choices: {
          intern: !!map.intern,
          newgrad: !!map.newgrad,
        },
      };
    }
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (
        !["jobs:site-links", "jobs:tab-profile", "jobs:popup-profile"].includes(
          msg?.type,
        )
      )
        return;
      if (sender.id !== chrome.runtime.id) {
        reply({ error: "Invalid caller" });
        return;
      }
      (msg.type === "jobs:site-links"
        ? register(msg, sender)
        : msg.type === "jobs:popup-profile"
          ? popup(msg, sender)
          : context(sender, msg)
      ).then(
        (data) => reply({ data }),
        (error) => reply({ error: error.message }),
      );
      return true;
    });
    // Capture Apply child tabs while their opener still exists, including a
    // child that starts at about:blank. An explicit website launch binds last.
    chrome.tabs.onCreated.addListener((tab) => {
      if (
        tab.url === "about:blank" &&
        !tab.pendingUrl &&
        tab.openerTabId !== undefined
      ) {
        // Capture the opener identity at creation, before its onRemoved event
        // releases facts. The child owns this temporary snapshot only until bind.
        const opening = JobsPrivateSession.readTab(tab.openerTabId);
        return inTab(tab.id, async () => {
          if (!(await selected(tab.id))) await inherit(tab, await opening);
        }).catch(() => {});
      }
      return candidate(tab)
        .then((active) =>
          active ? ensure({ tab, url: tab.url }, false) : undefined,
        )
        .catch(() => {});
    });
    chrome.tabs.onUpdated.addListener((id, change, tab) => {
      if (change.url)
        return inTab(id, async () => {
          if (!(await candidate(tab))) return;
          const value = await ensureTab({ tab }, false);
          if (value) {
            const meta = await metadata(id);
            await remember(tab, value, meta?.websiteJobId);
          }
        }).catch(() => {});
    });
    chrome.tabs.onRemoved.addListener((id, info) => {
      return releasePage(id)
        .then(() =>
          serial(async () => {
            // Browser shutdown also emits onRemoved. Keep the recovery snapshot then.
            if (!info?.isWindowClosing) {
              const saved =
                (await chrome.storage.local.get(RECOVERY))[RECOVERY] || {};
              delete saved[id];
              await chrome.storage.local.set({ [RECOVERY]: saved });
            }
            await chrome.storage.session.remove([
              "job_" + id,
              "jobsTabBinding:" + id,
              "profile_" + id,
              "jobsResponseTab:" + id,
            ]);
          }),
        )
        .catch(() => {});
    });
  })();
}
