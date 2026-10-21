import { JobsPageSession } from "../../src/custom/control-content.js";
import { JobsReviewPresenter } from "../../src/custom/review-presenter.js";
import { JobsAvailability } from "../../src/custom/job-availability.js";
import { JobsAppliedStatus } from "../../src/custom/applied-status.js";
import { jobsAdapterRoutes, jobsRunAdapter } from "./routing.js";
import { jobsGetProfile } from "./shared/profiles.js";
import { jobsJobTitle, jobsReportJobTitle } from "./shared/runtime-messages.js";
import { JobsJobMatch } from "../../src/custom/job-match.js";
import { stoppedMessage } from "../../src/custom/run-stop.js";

const postingHeading =
  '[data-automation-id="jobPostingHeader"],[data-automation-id="jobTitleHeading"]';
const descriptionSelector =
  '[data-automation-id="jobPostingDescription"],.jobs-description,.job-description,[itemprop="description"]';
const metadataSelector = `title,h1,${postingHeading},${descriptionSelector},script[type="application/ld+json"]`;
let savedDetails = "",
  previousDetails,
  metadataSync = Promise.resolve();

const phases = {
  idle: "就绪",
  "in-progress": "正在填写",
  "ai-thinking": "正在准备回答",
  "ai-filling": "正在填写回答",
  "ai-review": "等待审核",
  "complete-required": "请检查必填或校验提示",
  "complete-manually": "请在网页继续",
  "profile-unavailable": "请选择或检查本页 Profile",
  "page-complete": "本页已填好",
  "autofill-complete": "本页已填好",
  submitting: "已尝试提交，等待网站确认",
  confirmed: "网站已确认",
  "already-applied": "网站显示已申请，无需再次提交",
  "awaiting-transition": "等待下一页",
  "site-error": "网站返回错误",
};
export function lifecycle() {
  const controller = new AbortController();
  const context = {
    signal: controller.signal,
    get isInvalid() {
      return controller.signal.aborted;
    },
    abort: (reason) => controller.abort(reason),
    addEventListener: (target, type, callback, options = {}) =>
      target.addEventListener(type, callback, {
        ...options,
        signal: controller.signal,
      }),
    onInvalidated: (callback) =>
      controller.signal.addEventListener("abort", callback, { once: true }),
  };
  window.addEventListener("pagehide", () => controller.abort("pagehide"), {
    once: true,
  });
  return context;
}
export function statusPresenter(context) {
  const id = crypto.randomUUID();
  let available,
    active = true,
    transport = Promise.resolve();
  const perform = async (action) => {
    if (!active || !["draft", "refill"].includes(action))
      throw Error("当前操作不可用");
    return JobsPageSession[action]();
  };
  const publish = (text, extra = {}) => {
    JobsReviewPresenter?.status?.(
      { id, text, canFill: !!JobsPageSession, ...extra },
      perform,
    );
    transport = transport
      .catch(() => {})
      .then(async () => {
        if (active)
          await chrome.runtime.sendMessage({
            type: "jobs:panel-status",
            id,
            text,
            canFill: !!JobsPageSession,
            ...extra,
          });
      })
      .catch(() => {});
    return transport;
  };
  const listener = (message, sender, reply) => {
    if (message?.type !== "jobs:status-command") return;
    if (
      !active ||
      sender.id !== chrome.runtime.id ||
      sender.tab ||
      message.id !== id
    ) {
      reply({ error: "岗位提示已过期" });
      return;
    }
    if (["draft", "refill"].includes(message.action)) {
      perform(message.action).then(reply, (error) =>
        reply({ error: error.message }),
      );
      return true;
    }
    if (!available) {
      reply({ error: "当前操作不可用" });
      return;
    }
    if (message.action === "dismiss") {
      available.onDismiss();
      available = null;
      present("idle");
      reply({ ok: true });
    } else if (message.action === "restore" && available.canRestore) {
      Promise.resolve(available.onRestore()).then(
        () => reply({ ok: true }),
        () => reply({ error: "恢复尚未确认" }),
      );
      return true;
    } else reply({ error: "当前操作不可用" });
  };
  chrome.runtime.onMessage.addListener(listener);
  context.onInvalidated(() => {
    active = false;
    chrome.runtime.onMessage.removeListener(listener);
  });
  const present = (value) =>
    publish(stoppedMessage(value) || phases[value] || value || "就绪");
  present.availability = (data) => {
    available = data;
    publish(data.message, { canRestore: data.canRestore, dismissible: true });
  };
  return present;
}
export function extractJob(doc = document) {
  let json;
  for (const script of doc.querySelectorAll(
    'script[type="application/ld+json"]',
  ))
    try {
      const data = JSON.parse(script.textContent);
      const rows = Array.isArray(data) ? data : data["@graph"] || [data];
      json = rows.find((row) => row["@type"] === "JobPosting");
      if (json) break;
    } catch {}
  const observedTitle =
    [
      doc.querySelector(postingHeading)?.textContent,
      json?.title,
      doc.querySelector("h1")?.textContent,
    ]
      .map(jobsJobTitle)
      .find(Boolean) || "";
  const title = observedTitle || jobsJobTitle(doc.title);
  const source =
    json?.description ||
    doc.querySelector(descriptionSelector)?.innerHTML ||
    "";
  // Template contents are inert and never attach loading images/iframes to the
  // active document. Only plain text is returned to the background.
  const detached = doc.createElement("template");
  detached.innerHTML = source;
  return {
    title,
    observedTitle,
    identityUrl: typeof json?.url === "string" ? json.url : "",
    description: detached.content.textContent
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 18000),
    appUrl: location.href,
  };
}
// Keep the existing local context and title-reporting paths fed by the same
// observation. Only a server acknowledgement deduplicates a title report.
async function syncJobDetails(context, requireHeading = false) {
  const task = metadataSync.then(async () => {
    if (context.isInvalid) return;
    const details = extractJob();
    if (requireHeading && !details.observedTitle) return;
    if (
      previousDetails &&
      !JobsJobMatch.same(previousDetails.appUrl, details.appUrl) &&
      previousDetails.appUrl !== details.appUrl &&
      previousDetails.title === details.title &&
      !JobsJobMatch.same(details.identityUrl, details.appUrl)
    )
      return;
    // SPA URLs can change before their old posting DOM has been replaced.
    previousDetails = details;
    const signature = JSON.stringify(details);
    if (signature !== savedDetails) {
      await send({ type: "storeJobDetails", ...details });
      if (context.isInvalid || details.appUrl !== location.href) return;
      savedDetails = signature;
    }
    if (!context.isInvalid && details.appUrl === location.href)
      void jobsReportJobTitle(details.observedTitle, details.appUrl);
  });
  metadataSync = task.catch(() => {});
  return task;
}
async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (result?.error) throw Error(result.error);
  return result?.data ?? result;
}
export async function startPage(existingContext, recovery = false) {
  const route = jobsAdapterRoutes.find(
    (row) =>
      row.pattern?.test(location.href) ||
      (row.selector && document.querySelector(row.selector)),
  );
  const linkedIn =
    /(^|\.)linkedin\.com$/.test(location.hostname) &&
    location.pathname.startsWith("/jobs/");
  const context = existingContext || lifecycle();
  if (!route && !linkedIn) {
    // Recognized posting identities can report public metadata before an
    // application adapter exists. Generic URL fallbacks are not posting proof.
    const key = JobsJobMatch.key(location.href);
    if (key && JSON.parse(key)[1] !== "exact")
      await syncJobDetails(context, true).catch(() => {});
    // Keep watching for a late adapter marker; metadata does not start a form.
    return false;
  }
  const present = statusPresenter(context);
  JobsAvailability?.attach(
    present.availability,
    () =>
      !!(
        route?.pattern?.test(location.href) ||
        (route?.selector && document.querySelector(route.selector))
      ),
  );
  JobsAppliedStatus?.attach(present);
  try {
    // A title lookup must not hold up account entry or autofill if the server
    // is slow. It has its own acknowledgement and can retry on page activity.
    await syncJobDetails(context);
    // Status is advisory here. The final submission path independently checks
    // duplication; a slow status lookup must not delay sign-in or local filling.
    void send({ type: "jobs:application-status", url: location.href })
      .then((prior) => {
        if (!context.isInvalid && prior?.applied)
          present(prior.label || "此岗位已有投递记录");
      })
      .catch(() => {});
    const config = await send({ type: "getAutofillConfig" });
    if (!config?.enabled) return true;
    if (!route) {
      installLinkedInTracking(context);
      return true;
    }
    const options = {
      ctx: context,
      setMessage: present,
      autofillSettings: config.autofillSettings,
      accountSettings: config.accountSettings,
      getProfile: jobsGetProfile,
      jobsRecovery: recovery,
    };
    await jobsRunAdapter(route.script, options);
  } catch (error) {
    await present(error.message);
    if (recovery) context.abort("recovery unavailable");
  }
  return true;
}
// This observer exists only in known ATS pages or explicitly registered job
// domains. It watches late framework mounts and native SPA navigation.
export function watchPage() {
  let context = lifecycle();
  let started = false,
    starting = false,
    url = location.href;
  const inspect = async () => {
    if (context.isInvalid) return;
    if (location.href !== url) {
      url = location.href;
      const event = new Event("jobs:locationchange");
      Object.assign(event, { newUrl: new URL(url) });
      window.dispatchEvent(event);
    }
    if (started) {
      void syncJobDetails(context).catch(() => {});
      return;
    }
    if (starting) return;
    starting = true;
    try {
      started = await startPage(
        context,
        globalThis.__jobsRecoveryStart === true,
      );
    } finally {
      starting = false;
      if (started) void syncJobDetails(context).catch(() => {});
    }
  };
  let reconnecting;
  const reconnect = () => {
    if (!context.isInvalid) return Promise.resolve();
    if (!reconnecting) {
      context = lifecycle();
      attach();
      reconnecting = startPage(context, true)
        .then((value) => {
          started = value;
        })
        .finally(() => {
          reconnecting = null;
        });
    }
    return reconnecting;
  };
  globalThis.__jobsReconnectPage = reconnect;
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (
      message?.type !== "jobs:page-reconnect" ||
      sender.id !== chrome.runtime.id ||
      sender.tab
    )
      return;
    reconnect().then(
      () => reply({ ok: !context.isInvalid }),
      (error) => reply({ error: error.message }),
    );
    return true;
  });
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void inspect();
    });
  };
  const observer = new MutationObserver((records) => {
    if (
      !started ||
      location.href !== url ||
      records.some((record) => {
        const node =
          record.target.nodeType === 1
            ? /** @type {Element} */ (record.target)
            : record.target.parentElement;
        return (
          node?.closest(metadataSelector) ||
          [...record.addedNodes].some((added) => {
            if (added.nodeType !== 1) return false;
            const element = /** @type {Element} */ (added);
            return (
              element.matches(metadataSelector) ||
              element.querySelector(metadataSelector)
            );
          })
        );
      })
    )
      schedule();
  });
  function attach() {
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["id", "data-ph-id"],
    });
    context.addEventListener(window, "popstate", inspect);
    context.addEventListener(window, "hashchange", inspect);
    context.addEventListener(window, "online", inspect);
    context.addEventListener(window, "focus", inspect);
    if (window.navigation)
      context.addEventListener(window.navigation, "navigatesuccess", inspect);
    context.onInvalidated(() => {
      observer.disconnect();
      savedDetails = "";
    });
  }
  attach();
  void inspect();
  return context;
}
function installLinkedInTracking(context) {
  if (!/(^|\.)linkedin\.com$/.test(location.hostname)) return;
  let recorded = false;
  const observer = new MutationObserver(async () => {
    const proof = [...document.querySelectorAll('[role="alert"],h2,h3')].find(
      (node) =>
        /^(?:your application was sent|application submitted)$/i.test(
          node.textContent.trim(),
        ),
    );
    if (!proof || recorded) return;
    const id =
      location.pathname.match(/\/jobs\/view\/(\d+)/)?.[1] ||
      new URL(location.href).searchParams.get("currentJobId");
    if (!id) return;
    recorded = true;
    await send({
      type: "saveApplication",
      jobTitle: extractJob().title,
      jobLink: "https://www.linkedin.com/jobs/view/" + id + "/",
      jobsSyncProof: "ats_confirmation",
    });
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  context.onInvalidated(() => observer.disconnect());
}
