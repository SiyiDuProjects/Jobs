import { JobsAvailability } from "../../src/custom/job-availability.js";
import { JobsAppliedStatus } from "../../src/custom/applied-status.js";
import { jobsAdapterRoutes, jobsRunAdapter } from "./routing.js";
import { jobsGetProfile } from "./shared/profiles.js";
import { jobsJobTitle, jobsReportJobTitle } from "./shared/runtime-messages.js";
import { JobsJobMatch } from "../../src/custom/job-match.js";

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
  "complete-required": "还有必填项目",
  "complete-manually": "需要手动处理",
  "profile-unavailable": "请选择或检查本页 Profile",
  "page-complete": "本页已填好",
  "autofill-complete": "本页已填好",
  submitting: "已尝试提交，等待网站确认",
  confirmed: "网站已确认",
  "already-applied": "网站显示已申请，无需再次提交",
  "awaiting-transition": "等待下一页",
  "site-error": "网站返回错误",
  "queue-paused": "队列已暂停",
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
  const host = document.createElement("aside");
  host.dataset.jobsUi = "status";
  const shadow = host.attachShadow({ mode: "closed" }),
    style = document.createElement("style"),
    text = document.createElement("span");
  style.textContent =
    ":host{position:fixed;right:16px;bottom:16px;z-index:2147483646;font:14px system-ui;color:#222;background:#fff;border:1px solid #ccc;border-radius:10px;padding:10px 14px;box-shadow:0 2px 10px #0002}";
  text.setAttribute("role", "status");
  shadow.append(style, text);
  (document.body || document.documentElement).append(host);
  context.onInvalidated(() => host.remove());
  const present = (value) => {
    text.textContent = "Jobs · " + (phases[value] || value || "就绪");
  };
  present.availability = (data) => {
    text.textContent = data.message;
    for (const button of shadow.querySelectorAll("button")) button.remove();
    if (data.canRestore) {
      const restore = document.createElement("button");
      restore.type = "button";
      restore.textContent = "恢复";
      restore.onclick = () => void data.onRestore();
      shadow.append(restore);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "关闭";
    close.onclick = () => {
      data.onDismiss();
      host.remove();
    };
    shadow.append(close);
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
  const detached = doc.createElement("div");
  detached.innerHTML = source;
  return {
    title,
    observedTitle,
    identityUrl: typeof json?.url === "string" ? json.url : "",
    description: detached.textContent
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 18000),
    appUrl: location.href,
  };
}
// Keep the existing local context and title-reporting paths fed by the same
// observation. Only a server acknowledgement deduplicates a title report.
async function syncJobDetails(context) {
  const task = metadataSync.then(async () => {
    if (context.isInvalid) return;
    const details = extractJob();
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
export async function startPage(existingContext) {
  const route = jobsAdapterRoutes.find(
    (row) =>
      row.pattern?.test(location.href) ||
      (row.selector && document.querySelector(row.selector)),
  );
  const linkedIn =
    /(^|\.)linkedin\.com$/.test(location.hostname) &&
    location.pathname.startsWith("/jobs/");
  if (!route && !linkedIn) return false;
  const context = existingContext || lifecycle(),
    present = statusPresenter(context);
  JobsAvailability?.attach(present.availability);
  JobsAppliedStatus?.attach(present);
  try {
    // A title lookup must not hold up account entry or autofill if the server
    // is slow. It has its own acknowledgement and can retry on page activity.
    await syncJobDetails(context);
    const prior = await send({
      type: "jobs:application-status",
      url: location.href,
    });
    if (prior?.applied) present(prior.label || "此岗位已有投递记录");
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
    };
    await jobsRunAdapter(route.script, options);
  } catch (error) {
    present(error.message);
  }
  return true;
}
// This observer exists only in known ATS pages or explicitly registered job
// domains. It watches late framework mounts and native SPA navigation.
export function watchPage() {
  const context = lifecycle();
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
      started = await startPage(context);
    } finally {
      starting = false;
      if (started) void syncJobDetails(context).catch(() => {});
    }
  };
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
