import { JobsFormPipeline } from "./form-pipeline.js";
import { JobsDiagnostics } from "./diagnostics.js";
import { JobsControlFields } from "./control-fields.js";
import { JobsResponseContract } from "./response-contract.js";
import { JobsJobMatch } from "./job-match.js";
import { JobsPageSession } from "./control-content.js";
import { JobsProfileAnswers } from "./profile-answers.js";
export var JobsAnswerMemory;
let initialized = false;
export function initializeAnswerMemory() {
  if (initialized) return;
  initialized = true;
  (() => {
    let session;
    const note = (type, node) => {
      try {
        JobsDiagnostics?.note(type, node);
      } catch {}
    };
    const send = async (data) => {
      const result = await chrome.runtime.sendMessage({
        type: "saveResponses",
        data,
      });
      if (!result?.ok)
        throw Error(
          result?.error || "Saved Responses did not acknowledge the write",
        );
    };
    function start(root, enabled, save = send, scope = () => root) {
      session?.stop();
      session = null;
      if (!enabled) return;
      const doc = root.ownerDocument || root,
        view = doc.defaultView;
      const reader = JobsControlFields.create(doc, scope);
      const pending = new Map(),
        review = new Map(),
        timers = new Map(),
        inFlight = new Set(),
        userChoices = new WeakSet(),
        disposers = [];
      const isChoice = (row) =>
        ["checkbox", "custom-checkbox"].includes(row.public.type) ||
        JobsControlFields.choiceTypes.includes(row.public.type);
      let active = true;
      const key = (record) =>
        record.question.normalize("NFKC").trim().toLowerCase();
      function flush() {
        for (const timer of timers.values()) view.clearTimeout(timer);
        timers.clear();
        const entries = [...pending.entries()].filter(
          ([, item]) => !inFlight.has(item),
        );
        if (!entries.length) return;
        for (const [, item] of entries) {
          inFlight.add(item);
          note("memory_save_requested", item.node);
        }
        let task;
        try {
          task = save(entries.map(([, item]) => item.record));
        } catch (error) {
          task = Promise.reject(error);
        }
        void Promise.resolve(task).then(
          () => {
            for (const [id, item] of entries) {
              inFlight.delete(item);
              if (pending.get(id) === item) pending.delete(id);
              note("memory_saved", item.node);
            }
          },
          () => {
            // Retain the latest value for the next real interaction/blur/pagehide.
            // No silent success and no infinite background retry loop.
            for (const [, item] of entries) {
              inFlight.delete(item);
              note("memory_save_failed", item.node);
            }
          },
        );
      }
      function queue(record, node, immediate = false) {
        if (
          !active ||
          !record ||
          record.question.length > 4000 ||
          record.response.length > 4000
        )
          return;
        if (
          !record.jobKey &&
          JobsResponseContract?.jobSpecific(record.question)
        ) {
          const jobKey = JobsJobMatch?.key(doc.location.href);
          if (!jobKey || JSON.parse(jobKey)[1] === "exact") {
            note("memory_job_scope_unavailable", node);
            return;
          }
          record = { ...record, jobKey };
        }
        const scopeRoot = scope();
        if (JobsFormPipeline?.answered(scopeRoot)?.has(node)) {
          pending.delete(key(record));
          return;
        }
        const profile = JobsPageSession?.profile?.();
        const id = key(record);
        const answers = JobsProfileAnswers;
        if (
          profile &&
          answers?.covers(record, profile, {
            country: answers.scope(reader.scan().map((row) => row.public)),
          })
        ) {
          // Only an equivalent answer in this form's country scope is redundant.
          // Also discard a previously queued value after the user corrects it;
          // a later blur must not retry the stale answer.
          pending.delete(id);
          view.clearTimeout(timers.get(id));
          timers.delete(id);
          return;
        }
        pending.set(id, { record, node });
        view.clearTimeout(timers.get(id));
        if (immediate) flush();
        else timers.set(id, view.setTimeout(flush, 500));
      }
      function rowsFor(target) {
        if (!target?.closest) return [];
        const label = target.closest("label"),
          control = label?.control;
        const popup = target.closest('[role="listbox"]');
        return reader
          .scan()
          .filter(
            (row) =>
              row.node === target ||
              row.node.contains(target) ||
              row.node === control ||
              row.group.some(
                (node) =>
                  node === target || node.contains(target) || node === control,
              ) ||
              (popup?.id &&
                row.node.getAttribute("aria-controls") === popup.id),
          );
      }
      function capture(rows, immediate) {
        for (const row of rows) {
          // Even a user correction of an AI draft waits for the same confirmation.
          if (review.has(row.node)) continue;
          const record = reader.response(row);
          if (record) queue(record, row.node, immediate);
          else {
            own.cancel(row.node);
            note("memory_not_captured", row.node);
          }
        }
      }
      function interaction(event) {
        if (!active || !event.isTrusted || event.isComposing) return;
        const target = event.composedPath?.()[0] || event.target;
        if (event.type === "pointerdown" || event.type === "keydown") {
          for (const row of rowsFor(target))
            if (isChoice(row)) userChoices.add(row.node);
          return;
        }
        if (event.type === "focusout") {
          flush();
          return;
        }
        const immediate = event.type === "change";
        // HTMLElement.click() produces trusted native change/input events even
        // though its click is synthetic. A choice needs real user intent first.
        if (event.type === "input" || immediate) {
          const rows = rowsFor(target).filter(
            (row) => !isChoice(row) || userChoices.has(row.node),
          );
          capture(rows, immediate);
          if (immediate) for (const row of rows) userChoices.delete(row.node);
        }
        if (event.type === "click" || event.type === "keyup") {
          if (
            event.type === "keyup" &&
            ![
              " ",
              "Enter",
              "ArrowUp",
              "ArrowDown",
              "ArrowLeft",
              "ArrowRight",
            ].includes(event.key)
          )
            return;
          // A scripted label.click() can forward a trusted click to its input.
          // Trust click plus real pointer/keyboard intent, not isTrusted alone.
          const candidates = rowsFor(target).filter(
            (row) =>
              isChoice(row) &&
              (event.type === "keyup" || userChoices.has(row.node)),
          );
          if (candidates.length) {
            // Custom controls can commit after the click microtask. Watch only
            // controls touched by this real interaction, never the whole page.
            const changes = new view.MutationObserver(() => {
              if (active)
                capture(
                  reader
                    .scan()
                    .filter((row) =>
                      candidates.some((before) => before.node === row.node),
                    ),
                  true,
                );
            });
            for (const row of candidates)
              changes.observe(
                row.node.closest(
                  'fieldset,[role="radiogroup"],.ashby-application-form-field-entry',
                ) ||
                  row.node.parentElement ||
                  row.node,
                { attributes: true, childList: true, subtree: true },
              );
            const timeout = view.setTimeout(() => changes.disconnect(), 1500);
            disposers.push(() => {
              changes.disconnect();
              view.clearTimeout(timeout);
            });
          }
          view.queueMicrotask(() => {
            if (active && candidates.length) {
              capture(
                reader
                  .scan()
                  .filter((row) =>
                    candidates.some((before) => before.node === row.node),
                  ),
                true,
              );
              for (const row of candidates) userChoices.delete(row.node);
            }
          });
          if (target?.closest?.('button,input[type="submit"],[role="button"]'))
            flush();
        }
      }
      function on(target, type, fn) {
        target.addEventListener(type, fn, true);
        disposers.push(() => target.removeEventListener(type, fn, true));
      }
      for (const type of [
        "pointerdown",
        "keydown",
        "input",
        "change",
        "focusout",
        "click",
        "keyup",
      ])
        on(root, type, interaction);
      on(doc, "submit", flush);
      on(view, "pagehide", flush);
      const own = {
        flush,
        stop({ discard = false } = {}) {
          if (discard) {
            for (const timer of timers.values()) view.clearTimeout(timer);
            timers.clear();
            pending.clear();
            review.clear();
            inFlight.clear();
          } else flush();
          active = false;
          for (const dispose of disposers) dispose();
        },
        remember(question, node, { requireReview = false, learn = true } = {}) {
          if (requireReview && active && question && node?.isConnected) {
            review.set(node, { question, learn });
            note(
              learn
                ? "memory_awaiting_review"
                : "memory_profile_or_unknown_skipped",
              node,
            );
            return;
          }
          if (!learn) {
            note("memory_profile_or_unknown_skipped", node);
            return;
          }
          if (
            !active ||
            !node?.isConnected ||
            node.disabled ||
            node.readOnly ||
            node.closest('[aria-invalid="true"]') ||
            (node.willValidate && !node.validity.valid)
          )
            return;
          const row = reader.scan().find((item) => item.node === node);
          const record = row && reader.response(row);
          if (row?.public.conditional) {
            if (!record) return;
            question = record.question;
          }
          // Generate Answer supplies its adapter's question for unlabelled textareas.
          const response =
            record?.response ||
            (node.matches("textarea") ? node.value.trim() : "");
          if (question && response) {
            // Generated/reviewed drafts can describe one employer or role. Keep
            // them reusable in this job only; ordinary real user input still uses
            // capture() above, and explicit reusable rules remain Profile-wide.
            const jobKey = JobsJobMatch?.key(doc.location.href);
            if (!jobKey || JSON.parse(jobKey)[1] === "exact") {
              note("memory_job_scope_unavailable", node);
              return;
            }
            queue({ question, response, jobKey }, node, true);
          }
        },
        confirmReview(nodes) {
          for (const node of nodes)
            if (review.has(node)) {
              const item = review.get(node);
              if (item.learn) own.remember(item.question, node);
              review.delete(node);
            }
        },
        discardReview(nodes) {
          for (const node of nodes) review.delete(node);
        },
        cancel(node) {
          for (const [id, item] of pending)
            if (item.node === node) {
              pending.delete(id);
              view.clearTimeout(timers.get(id));
              timers.delete(id);
            }
        },
      };
      session = own;
      return own;
    }
    function configure(enabled, ctx) {
      const own = start(document, enabled, send, () => {
        if (JobsPageSession) return JobsPageSession.root();
        const forms = Array.from(document.querySelectorAll("form")).filter(
          (node) => !node.closest('[hidden],[aria-hidden="true"]'),
        );
        return forms.length === 1 ? forms[0] : null;
      });
      ctx?.onInvalidated?.(() => {
        if (session === own) {
          own?.stop();
          session = null;
        }
      });
    }
    JobsAnswerMemory = Object.freeze({
      configure,
      start,
      stop: (options = {}) => {
        session?.stop(options);
        session = null;
      },
      remember: (question, node, options) =>
        session?.remember(question, node, options),
      confirmReview: (nodes) => session?.confirmReview(nodes),
      discardReview: (nodes) => session?.discardReview(nodes),
      cancel: (node) => session?.cancel(node),
      flush: () => session?.flush(),
    });
  })();
}
