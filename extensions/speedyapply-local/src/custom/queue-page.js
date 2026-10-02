import { JobsPlatformConfig } from "./platform-config.js";
import { JobsPageActions } from "./page-actions.js";
export var JobsQueuePage;
let initialized = false;
export function initializeQueuePage() {
  if (initialized) return;
  initialized = true;
  (() => {
    if (JobsQueuePage || location.protocol !== "https:") return;
    let bridge = {},
      generation = 0;
    const documentId = crypto.randomUUID();
    let permission = { owned: true, allowed: false },
      disposed = false,
      reporting = false,
      entryBusy = false,
      navigationPermit = false;
    const send = async (data) => {
      const reply = await chrome.runtime.sendMessage({
        type: "jobs:queue-page",
        data: { ...data, document: documentId, url: location.href },
      });
      if (reply?.error) throw Error(reply.error);
      return reply?.data;
    };
    const allowed = (epoch) =>
      !disposed &&
      (epoch === undefined || epoch === generation) &&
      (!permission.owned || permission.allowed || navigationPermit);
    const guard = (check) => {
      const epoch = generation;
      return () => allowed(epoch) && check();
    };
    const ready = send({ type: "hello" })
      .then((data) => {
        if (data) permission = data;
        return permission;
      })
      .catch(() => permission);
    const visible = (node) => {
      if (
        !node?.isConnected ||
        node.closest('[hidden],[inert],[aria-hidden="true"]')
      )
        return false;
      for (let parent = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden")
          return false;
      }
      return true;
    };
    function blocker() {
      if (
        [
          ...document.querySelectorAll(
            'iframe[src*="/bframe"],iframe[title*="challenge"],iframe[title*="Challenge"]',
          ),
        ].some(visible)
      )
        return "等待验证码处理";
      if (
        [
          ...document.querySelectorAll(
            'input[autocomplete="one-time-code"],input[name*="verificationCode" i],input[name*="otp" i]',
          ),
        ].some(visible)
      )
        return "等待验证码／邮箱验证";
      if (
        [...document.querySelectorAll('[role="alert"],h1,h2')].some(
          (node) =>
            visible(node) &&
            /verify (?:that )?you are human|security challenge|complete the captcha/i.test(
              node.textContent,
            ),
        )
      )
        return "等待验证码处理";
      return "";
    }
    async function step(action, root, target) {
      const fields = bridge.scan?.(root) || [];
      const identity = JSON.stringify([
        location.href,
        action,
        root?.getAttribute("data-automation-id"),
        fields.map((row) => [row.public.question, row.public.type]),
        target?.id,
        target?.getAttribute("data-automation-id"),
        target?.getAttribute("href"),
        target?.textContent?.trim().slice(0, 150),
      ]);
      return [
        ...new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(identity),
          ),
        ),
      ]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    }
    async function verify() {
      await ready;
      if (!permission.owned) return;
      const result = await send({ type: "check" });
      if (result) permission = result;
      if (!allowed()) throw Error("队列已暂停或提交结果待核实");
      if (permission.entryOnly)
        throw Error("当前页面仅可处理登录／进入步骤，尚未核对同一岗位");
    }
    let submissionGuard,
      submissionAttempted = false,
      clickingSubmit = false,
      clickValidation = false,
      manualSubmit = false;
    async function beforeNavigate(action, root, target) {
      await ready;
      if (action === "submit" && !submissionGuard) {
        const reply = await chrome.runtime.sendMessage({
          type: "jobs:submission-prepare",
          url: location.href,
        });
        if (reply?.error || !reply?.data?.id)
          throw Error(reply?.error || "无法建立提交保护");
        submissionGuard = reply.data.id;
      }
      if (!permission.owned) return;
      const epoch = generation;
      if (!allowed()) throw Error("队列已暂停");
      const reason = blocker();
      if (reason) throw Error(reason);
      await send({
        type: "intent",
        action,
        step: await step(action, root, target),
      });
      if (epoch !== generation || !allowed())
        throw Error("队列状态已变化，原导航已停止");
      // The persisted attempt authorizes this immediate, revalidated click only.
      // No lease is kept across reload, worker restart or a second navigation.
      navigationPermit = true;
    }
    function afterNavigate() {
      navigationPermit = false;
      if (permission.owned) permission = { ...permission, allowed: false };
      if (submissionGuard) {
        submissionAttempted = true;
        void chrome.runtime
          .sendMessage({
            type: "jobs:submission-attempted",
            id: submissionGuard,
            url: location.href,
          })
          .catch(() => {});
        if (clickValidation) validationError();
      }
    }
    function clickNavigate(action, target) {
      if (!JobsPageActions.allowed()) return false;
      clickingSubmit = action === "submit";
      clickValidation = false;
      let dispatched = false;
      const observeClick = (event) => {
        if (event.composedPath().includes(target)) dispatched = true;
      };
      window.addEventListener("click", observeClick, true);
      try {
        const clicked = JobsPageActions.click(target);
        return clicked && dispatched;
      } finally {
        window.removeEventListener("click", observeClick, true);
        // A method return or exception alone is not an executed click. Retain
        // preparation if dispatch is unproven; never manufacture an attempt.
        if (dispatched) afterNavigate();
        else {
          navigationPermit = false;
          if (permission.owned) permission = { ...permission, allowed: false };
        }
        clickingSubmit = false;
        clickValidation = false;
      }
    }
    function validationError() {
      if (clickingSubmit && !submissionAttempted) {
        clickValidation = true;
        return;
      }
      if (manualSubmit) {
        void chrome.runtime
          .sendMessage({
            type: "jobs:submission-observed",
            url: location.href,
            validationError: true,
          })
          .catch(() => {});
        return;
      }
      if (submissionGuard && submissionAttempted)
        void chrome.runtime
          .sendMessage({
            type: "jobs:submission-validation-error",
            id: submissionGuard,
            url: location.href,
          })
          .catch(() => {});
    }
    document.addEventListener("invalid", validationError, true);
    const manualRoots = new WeakSet();
    function trackManualSubmit(root, text) {
      if (!root || manualRoots.has(root)) return;
      manualRoots.add(root);
      root.addEventListener(
        "click",
        (event) => {
          if (clickingSubmit || disposed) return;
          const target = event
            .composedPath()
            .find(
              (node) =>
                node instanceof Element &&
                node.matches('button,input[type="submit"],[role="button"]'),
            );
          if (
            !(target instanceof HTMLElement) ||
            !root.contains(target) ||
            !visible(target) ||
            target.matches(':disabled,[aria-disabled="true"]') ||
            !text.test(
              (target instanceof HTMLInputElement
                ? target.value
                : target.textContent
              ).trim(),
            )
          )
            return;
          manualSubmit = true;
          // The worker owns the full observe -> persist transaction. This page
          // must not await a prepare ACK before sending the executed attempt.
          void chrome.runtime
            .sendMessage({
              type: "jobs:submission-observed",
              url: location.href,
            })
            .catch(() => {});
        },
        true,
      );
    }
    async function enter() {
      if (
        entryBusy ||
        !permission.owned ||
        !allowed() ||
        bridge.state?.().active
      )
        return;
      entryBusy = true;
      const epoch = generation;
      try {
        const reason = blocker();
        if (reason) {
          await send({ type: "status", blocker: reason });
          return;
        }
        let action = "entry",
          candidate;
        const passwords = [
          ...document.querySelectorAll('input[type="password"]'),
        ]
          .filter((node) => node instanceof HTMLInputElement)
          .filter(visible);
        if (passwords.length) {
          const form = passwords[0].closest("form") || document;
          const usernames = [
            ...form.querySelectorAll(
              /** @type {'input'} */ (
                'input[type="email"],input[autocomplete="username"],input[name*="email" i],input[name*="username" i]'
              ),
            ),
          ].filter(visible);
          if (
            passwords.length !== 1 ||
            !passwords[0].value ||
            usernames.length !== 1 ||
            !usernames[0].value
          ) {
            await send({
              type: "status",
              blocker: "需要完成登录；队列保留当前页面",
            });
            return;
          }
          const buttons = [
            ...form.querySelectorAll('button,input[type="submit"]'),
          ].filter(
            (node) =>
              visible(node) &&
              !(node instanceof HTMLButtonElement ||
              node instanceof HTMLInputElement
                ? node.disabled
                : false) &&
              /^(?:sign in|log in|login)$/i.test(
                (node instanceof HTMLInputElement
                  ? node.value
                  : node.textContent
                ).trim(),
              ),
          );
          if (buttons.length === 1) {
            candidate = buttons[0];
            action = "login";
          }
        } else {
          const selectors =
            'a[href],button[data-automation-id="applyNow"],button[data-automation-id="applyManually"],[role="tab"]';
          const buttons = [...document.querySelectorAll(selectors)].filter(
            (node) =>
              visible(node) &&
              !(node instanceof HTMLButtonElement ||
              node instanceof HTMLInputElement
                ? node.disabled
                : false) &&
              /^(?:apply|apply now|apply for this job|apply manually|application)$/i.test(
                node.textContent.trim(),
              ) &&
              !JobsPlatformConfig.roots(document, bridge.ats).some((owner) =>
                owner.contains(node),
              ),
          );
          const unique = buttons.filter(
            (node) =>
              !node.matches("a") ||
              (node.href.startsWith("https://") &&
                new URL(node.href).origin === location.origin),
          );
          if (unique.length === 1) candidate = unique[0];
        }
        if (!candidate) return;
        const url = location.href,
          identity = JSON.stringify([
            candidate.parentNode?.tagName,
            candidate.getAttribute("href"),
            candidate.textContent,
          ]);
        const signature = await step(action, document.body, candidate);
        await send({ type: "intent", action, step: signature });
        if (
          !allowed(epoch) ||
          location.href !== url ||
          !visible(candidate) ||
          candidate.disabled ||
          JSON.stringify([
            candidate.parentNode?.tagName,
            candidate.getAttribute("href"),
            candidate.textContent,
          ]) !== identity
        )
          return;
        if (
          action === "entry" &&
          JobsPlatformConfig.roots(document, bridge.ats).some((owner) =>
            owner.contains(candidate),
          )
        )
          return;
        if (
          action === "login" &&
          passwords.some((node) => !node.isConnected || !node.value)
        )
          return;
        if (candidate.matches("a")) location.assign(candidate.href);
        else JobsPageActions.click(candidate);
      } catch (error) {
        await send({
          type: "status",
          blocker: String(error.message || error),
        }).catch(() => {});
      } finally {
        entryBusy = false;
      }
    }
    async function report({ confirmed = false } = {}) {
      await ready;
      if (disposed || !permission.owned || reporting) return;
      reporting = true;
      const epoch = generation;
      try {
        const state = bridge.state?.() || {};
        const reason =
          blocker() ||
          (/^(?:complete-required|complete-manually|profile-unavailable|site-error|unsupported_form)$/.test(
            state.phase,
          )
            ? "页面需要处理：" + state.phase
            : "");
        const payload = {
          type: "status",
          phase: state.phase,
          active: state.active === true,
          finalReady: state.finalReady === true,
          confirmed,
          blocker: reason,
        };
        const result = await send(payload);
        if (epoch !== generation) return;
        const wasEntryOnly = permission.entryOnly;
        if (result) permission = result;
        if (wasEntryOnly && !permission.entryOnly && permission.allowed)
          void bridge.resume?.();
        if (!state.active && allowed()) void enter();
      } catch {
        permission = { ...permission, allowed: false };
      } finally {
        reporting = false;
      }
    }
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (
        message?.type !== "jobs:queue-control" ||
        sender.id !== chrome.runtime.id ||
        sender.tab
      )
        return;
      const previous = permission;
      permission = message.state;
      navigationPermit = false;
      if (
        previous.allowed !== permission.allowed ||
        previous.mode !== permission.mode ||
        previous.itemId !== permission.itemId
      )
        generation++;
      if (!allowed() && !bridge.pending?.()) bridge.cancel?.();
      if (permission.allowed && !previous.allowed)
        void send({ type: "hello" })
          .then((data) => {
            permission = data;
            if (bridge.resume) void bridge.resume();
            else void enter();
          })
          .catch(() => {});
      reply({ ok: true });
    });
    const timer = setInterval(() => {
      void report();
    }, 5000);
    const begin = () => {
      void ready.then(() => report());
    };
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", begin, { once: true });
    else begin();
    window.addEventListener(
      "pagehide",
      () => {
        disposed = true;
        clearInterval(timer);
      },
      { once: true },
    );
    JobsQueuePage = Object.freeze({
      ready,
      allowed,
      guard,
      verify,
      beforeNavigate,
      afterNavigate,
      clickNavigate,
      trackManualSubmit,
      validationError,
      attach: (value) => {
        bridge = value;
      },
      phase: () => {
        if (!reporting) void report();
      },
      confirmed: () => report({ confirmed: true }),
      configure: async (options) => {
        await verify();
        return permission.owned
          ? {
              ...options,
              autofillSettings: {
                ...options.autofillSettings,
                autoClickNextPage: true,
                autoSubmit: permission.mode === "apply",
              },
            }
          : options;
      },
    });
  })();
}
