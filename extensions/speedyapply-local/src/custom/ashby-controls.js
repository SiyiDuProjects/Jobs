import { JobsPlatformConfig } from "./platform-config.js";
import { JobsDOMWait } from "./dom-wait.js";
import { JobsPageActions } from "./page-actions.js";
import { JobsControlFields } from "./control-fields.js";

export var JobsAshbyControls;
let initialized = false;
export function initializeAshbyControls() {
  if (initialized) return;
  initialized = true;
  // Ashby DOM adapter. Answers are supplied by SpeedyApply's selected profile /
  // Saved Responses resolver; this module contains no personal answers.
  (() => {
    const normalize = (value) =>
      String(value ?? "")
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
    const editable = (element) =>
      element?.isConnected && !element.disabled && !element.readOnly;

    function listbox(input) {
      const id = input.getAttribute("aria-controls");
      const target = id && input.ownerDocument.getElementById(id);
      return target?.getAttribute("role") === "listbox" ? target : null;
    }

    function waitFor(read, timeout = 1200) {
      return JobsDOMWait.until(read, { timeout });
    }

    // Canonical school results also display country and domain. Only their
    // explicit name node is the option label and the value committed by Ashby.
    const optionLabel = (option) =>
      option.querySelector('[class*="_canonicalSchoolResultName_"]')
        ?.textContent ?? option.textContent;
    const optionNodes = (root) =>
      root?.querySelector("[data-loading]")
        ? []
        : Array.from(root?.querySelectorAll('[role="option"]') || []).filter(
            (node) => node.getAttribute("aria-disabled") !== "true",
          );

    function exactOption(root, answer) {
      const matches = optionNodes(root).filter(
        (option) => normalize(optionLabel(option)) === normalize(answer),
      );
      return matches.length === 1 ? matches[0] : null;
    }

    async function chooseOptions(
      input,
      pick,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        query = "",
        inspect = false,
      } = /** @type {{canProceed?: () => boolean, query?: string, inspect?: boolean}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (
        !JobsPageActions.live(canProceed) ||
        !editable(input) ||
        input.value.trim()
      )
        return false;
      const toggle = input.parentElement.querySelector("button");
      if (!toggle || toggle.disabled) return false;
      let draft = "",
        edited = false,
        committed = false;
      const url = input.ownerDocument.location.href;
      const onInput = (event) => {
        if (event.isTrusted) edited = true;
      };
      const current = () =>
        JobsPageActions.live(canProceed) &&
        editable(input) &&
        !edited &&
        input.ownerDocument.location.href === url;
      const ownsDraft = () => current() && input.value === draft;
      const cancelled = {};
      const read = () => {
        if (!ownsDraft()) return cancelled;
        const labels = optionNodes(listbox(input)).map(optionLabel);
        const selected = pick(labels);
        return selected ? exactOption(listbox(input), selected) : null;
      };
      input.addEventListener("input", onInput, true);
      try {
        input.focus();
        if (input.getAttribute("aria-expanded") !== "true")
          JobsPageActions.click(toggle);
        let option = read();
        // The shared rule supplies one query per transaction. A school list can
        // be empty until input; opening it is not a search and text is not a choice.
        if (!option && query && ownsDraft()) {
          draft = String(query);
          // A query is a draft, not a text-field commit. Wait for the actual
          // options below, without writeText's timer-based blur settling.
          const typed = JobsControlFields.writeValue(input, draft);
          if (!typed) return false;
        }
        option ||= await waitFor(read, query ? 3000 : 1200);
        if (!option || option === cancelled || !ownsDraft() || inspect)
          return false;
        const selectedLabel = normalize(optionLabel(option));
        JobsPageActions.click(option);
        committed = Boolean(
          await waitFor(() =>
            !current()
              ? cancelled
              : normalize(input.value) === selectedLabel &&
                input.getAttribute("aria-expanded") !== "true",
          ),
        );
        committed =
          committed &&
          current() &&
          normalize(input.value) === selectedLabel &&
          input.getAttribute("aria-expanded") !== "true";
        return committed;
      } finally {
        if (current()) {
          // Clear only our own uncommitted query, never a person's later edit.
          if (!committed && draft && ownsDraft())
            JobsControlFields.writeValue(input, "");
          if (current() && input.getAttribute("aria-expanded") === "true")
            JobsPageActions.click(toggle);
          if (current()) input.blur();
        }
        input.removeEventListener("input", onInput, true);
      }
    }

    async function readOptions(
      input,
      canProceed = /** @type {() => boolean} */ (() => true),
      { answer = "" } = /** @type {{answer?: string}} */ ({}),
    ) {
      let choices = [];
      await chooseOptions(
        input,
        (labels) => {
          choices = labels.map((label) => label.trim()).filter(Boolean);
          return choices[0];
        },
        { canProceed, query: answer, inspect: true },
      );
      return choices.length <= 150 && new Set(choices).size === choices.length
        ? choices.map((label) => ({ value: label, label }))
        : [];
    }

    function watch(xpath, run, onEmpty, ctx, onError = onEmpty) {
      let current,
        form,
        url = "",
        stopped = false;
      const check = () => {
        if (stopped) return;
        const node = document.evaluate(
          xpath,
          document,
          null,
          9,
          null,
        ).singleNodeValue;
        if (location.href !== url) {
          current?.abort();
          current = null;
          form = null;
          url = location.href;
        }
        if (!node || node.nodeType !== 1) {
          onEmpty?.();
          return;
        }
        const next =
          /** @type {Element} */ (node).closest(
            JobsPlatformConfig.structure.ashby.root,
          ) || node;
        if (next === form) return;
        current?.abort();
        current = new AbortController();
        form = next;
        const owner = current,
          initialUrl = location.href;
        const life = {
          root: next,
          signal: owner.signal,
          submitted: false,
          current: () =>
            !stopped &&
            !owner.signal.aborted &&
            location.href === initialUrl &&
            next.isConnected,
          canConfirm: () =>
            !stopped && !owner.signal.aborted && location.href === initialUrl,
          assertCurrent() {
            if (!this.current()) throw Error("Application form was replaced");
          },
        };
        void Promise.resolve()
          .then(() => run(life))
          .catch((error) => {
            if (life.current()) onError?.(error);
          });
      };
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      const stop = () => {
        stopped = true;
        current?.abort();
        observer.disconnect();
        window.removeEventListener("popstate", check);
        window.removeEventListener("hashchange", check);
      };
      window.addEventListener("popstate", check);
      window.addEventListener("hashchange", check);
      ctx?.onInvalidated?.(stop);
      check();
      return stop;
    }
    const isControl = (node) =>
      node?.ownerDocument.location.hostname === "jobs.ashbyhq.com" &&
      node.matches('input[role="combobox"]');
    // Every entrance (a binding, a known answer, AI, remote review)
    // ends here: record what was asked and what the control holds afterwards.

    // The only public component transaction. Selection belongs to the caller;
    // this component exposes page facts, commits the selection and reads it back.
    async function chooseFrom(node, pick, options = {}) {
      return chooseOptions(node, pick, options);
    }
    JobsAshbyControls = Object.freeze({
      isControl,
      chooseFrom,
      readOptions,
      watch,
    });
  })();
}
