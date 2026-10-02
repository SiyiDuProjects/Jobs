import { JobsMatchRules } from "./job-match-rules.js";
import { JobsJobMatch } from "./job-match.js";
import { JobsAvailabilityRules } from "./availability-rules.js";
export var JobsAvailability;
let initialized = false;
export function initializeJobAvailability() {
  if (initialized) return;
  initialized = true;
  (() => {
    if (window !== window.top) return;
    let show,
      last,
      seen,
      stable,
      timer,
      sending = false,
      dismissed = false;
    const labels = {
      pending: "岗位已失效，待同步移除…",
      removed: "岗位已失效，已从列表移除",
      already_removed: "该岗位已在回收站",
      protected: "岗位已失效，已保留现有记录",
      unmatched: "岗位已失效，未匹配到列表记录",
      expired: "失效记录已过期，未移除岗位",
      restoring: "正在恢复岗位…",
      restored: "岗位已恢复，不会再次自动移除",
      restore_expired: "恢复期限已过，请到岗位列表查看",
      restore_conflict: "岗位状态已变化，请到回收站查看",
    };
    function present(data) {
      if (data.error) data = { state: "error", error: data.error };
      // A quick acknowledgement can arrive before the initial pending reply.
      if (
        last &&
        data.state === "pending" &&
        !["pending", "error"].includes(last.state)
      )
        return;
      if (last?.state === "restored" && data.state === "restoring") return;
      last = data;
      if (!show || dismissed) return;
      const detail =
        data.error ||
        [data.company, data.title, data.removal_reason]
          .filter(Boolean)
          .join(" · ");
      show({
        message: [
          labels[data.state] || "岗位状态同步失败，未确认移除",
          detail,
          seen?.quote,
        ]
          .filter(Boolean)
          .join("\n"),
        canRestore:
          data.state === "removed" && data.expires_at * 1000 > Date.now(),
        onDismiss: () => {
          dismissed = true;
        },
        onRestore: async () => {
          present({ ...data, state: "restoring" });
          try {
            present(
              await chrome.runtime.sendMessage({
                type: "jobs:availability-restore",
                url: location.href,
                eventId: data.event_id,
              }),
            );
          } catch {
            present({ error: "恢复尚未确认，请稍后到回收站查看" });
          }
        },
      });
    }
    function detect() {
      // Only a known ATS host: a generic identifier rule (gh_jid on any site) does
      // not make an arbitrary page an application page.
      if (
        !JobsMatchRules?.some(
          (rule) =>
            !rule.fallthrough && new RegExp(rule.host).test(location.hostname),
        ) ||
        !JobsJobMatch.key(location.href)
      )
        return null;
      for (const node of [
        ...document.querySelectorAll("h1,h2,h3,p,div,span"),
      ].slice(0, 5000)) {
        if (
          node.closest(
            '[data-jobs-owner],script,style,textarea,[contenteditable="true"]',
          )
        )
          continue;
        const quote = JobsAvailabilityRules.normalize(node.textContent);
        if (quote.length > 250) continue;
        const code = JobsAvailabilityRules.code(quote);
        if (!code) continue;
        if (!node.getClientRects().length) continue;
        let visible = true;
        for (let current = node; current; current = current.parentElement) {
          const style = getComputedStyle(current);
          if (
            current.hasAttribute("hidden") ||
            current.getAttribute("aria-hidden") === "true" ||
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.opacity === "0"
          ) {
            visible = false;
            break;
          }
        }
        if (visible) return { code, quote, url: location.href };
      }
      return null;
    }
    async function scan() {
      clearTimeout(timer);
      const found = detect();
      if (!found) {
        stable = null;
        return;
      }
      const key = JSON.stringify(found);
      if (seen && JSON.stringify(seen) === key) return;
      if (stable?.key !== key) {
        stable = { key, at: Date.now() };
        timer = setTimeout(scan, 1500);
        return;
      }
      if (Date.now() - stable.at < 1500) {
        timer = setTimeout(scan, 1500 - (Date.now() - stable.at));
        return;
      }
      if (sending) return;
      sending = true;
      seen = found;
      dismissed = false;
      last = null;
      try {
        present(
          await chrome.runtime.sendMessage({
            type: "jobs:availability-observe",
            ...found,
          }),
        );
      } catch {
        present({ error: "插件连接暂不可用，岗位未确认移除" });
      } finally {
        sending = false;
      }
    }
    JobsAvailability = Object.freeze({
      attach(presenter) {
        show = presenter;
        if (last) present(last);
      },
      detect,
    });
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (
        msg?.type === "jobs:availability-result" &&
        sender.id === chrome.runtime.id &&
        !sender.tab &&
        JobsJobMatch.same(msg.url, location.href)
      )
        present(msg.data);
    });
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(scan, 250);
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["hidden", "style", "class", "aria-hidden"],
    });
    void scan();
  })();
}
