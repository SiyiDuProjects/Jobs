import { JobsDiagnostics } from "./diagnostics.js";
import { JobsPageActions } from "./page-actions.js";
import { JobsDOMWait } from "./dom-wait.js";

export var JobsDisclosureControls;
let initialized = false;
export function initializeDisclosureControls() {
  if (initialized) return;
  initialized = true;
  // Comeet's disclosure lists use clickable divs rather than native selects.
  // Original profile mappings remain in the adapter; every entrance shares this
  // list operation and separates a click from observable selected-state evidence.
  (() => {
    const text = (value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const normalize = (value) => text(value).normalize("NFKC").toLowerCase();
    const pending = new WeakMap(),
      cancelled = {};
    function visible(node) {
      if (
        !node?.isConnected ||
        node.closest('[hidden],[inert],[aria-hidden="true"]')
      )
        return false;
      for (let item = node; item?.nodeType === 1; item = item.parentElement) {
        const style = node.ownerDocument.defaultView.getComputedStyle(item);
        if (style.display === "none" || style.visibility === "hidden")
          return false;
      }
      return true;
    }
    function legend(list) {
      if (!list?.matches?.("ul")) return null;
      // Match the original legend-parent/following-div/list relationship. Never
      // adopt another disclosure's legend from a broad enclosing form.
      for (
        let owner = list.parentElement;
        owner && !owner.matches("form,body");
        owner = owner.parentElement
      ) {
        if (!owner.matches("div")) continue;
        for (
          let previous = owner.previousElementSibling;
          previous;
          previous = previous.previousElementSibling
        ) {
          const labels = [...previous.children].filter((child) =>
            child.matches("legend"),
          );
          if (
            labels.length === 1 &&
            /gender|ethnicity|veteran|disability/i.test(labels[0].textContent)
          )
            return labels[0];
        }
      }
      return null;
    }
    function options(list) {
      if (!list) return [];
      // The source clicks the div whose own text contains the answer. Avoid
      // counting an outer wrapper and its inner text div as two options.
      return [...list.querySelectorAll("div")].filter(
        (node) =>
          node.closest("ul") === list &&
          [...node.childNodes].some(
            (child) => child.nodeType === 3 && text(child.textContent),
          ),
      );
    }
    const isControl = (node) => !!legend(node) && options(node).length > 0;
    function find(scope = document) {
      return [scope, ...scope.querySelectorAll("ul")].filter(
        (node) => isControl(node) && visible(node),
      );
    }
    const question = (node) => text(legend(node)?.textContent);
    const enabled = (option) =>
      visible(option) &&
      option.getAttribute("aria-disabled") !== "true" &&
      !option.querySelector("input:disabled") &&
      !option.closest('[aria-disabled="true"]');
    function status(node) {
      const candidates = options(node),
        radios = [...node.querySelectorAll('input[type="radio"]')];
      const selected = candidates.filter(
        (option) =>
          option.getAttribute("aria-checked") === "true" ||
          option.getAttribute("aria-selected") === "true" ||
          option.querySelector(
            '[aria-checked="true"],[aria-selected="true"],input[type="radio"]:checked',
          ) ||
          radios.some(
            (radio) => radio.checked && radio.closest("li")?.contains(option),
          ),
      );
      const allReadable =
        candidates.length > 0 &&
        candidates.every(
          (option) =>
            option.hasAttribute("aria-checked") ||
            option.hasAttribute("aria-selected") ||
            option.querySelector(
              '[aria-checked],[aria-selected],input[type="radio"]',
            ) ||
            radios.some((radio) => radio.closest("li")?.contains(option)),
        );
      return {
        value: selected.length === 1 ? text(selected[0].textContent) : "",
        readable: allReadable && selected.length <= 1,
      };
    }
    const value = (node) => status(node).value;
    const cachedOptions = (node) =>
      options(node)
        .filter(enabled)
        .map((option) => ({
          value: text(option.textContent),
          label: text(option.textContent),
        }));
    function describe(node) {
      if (!isControl(node)) return null;
      const label = question(node),
        candidates = options(node),
        group = [
          ...new Set([
            node,
            ...candidates,
            ...node.querySelectorAll('input,[role="radio"]'),
          ]),
        ];
      const evidence = status(node),
        required =
          /\*\s*$/.test(label) ||
          group.some(
            (item) =>
              item.required || item.getAttribute("aria-required") === "true",
          );
      const attempted = pending.get(node);
      if (
        attempted?.question === label &&
        evidence.readable &&
        evidence.value &&
        (normalize(evidence.value) === normalize(attempted.answer) ||
          evidence.value !== attempted.previous)
      )
        pending.delete(node);
      const native = [...node.querySelectorAll('input[type="radio"]')];
      const disabled =
        node.getAttribute("aria-disabled") === "true" ||
        (native.length > 0 && native.every((input) => input.disabled));
      return {
        type: "custom-radio",
        component: "disclosure-list",
        question: label,
        value: evidence.value,
        readable: evidence.readable,
        options: cachedOptions(node),
        group,
        required,
        requiredKnown:
          required ||
          /\boptional\b/i.test(label) ||
          native.length > 0 ||
          group.some((item) => item.hasAttribute("aria-required")),
        disabled,
        invalid: group.some(
          (item) =>
            item.getAttribute("aria-invalid") === "true" ||
            (item.willValidate && !item.validity.valid),
        ),
        supported: !!label && !disabled,
        commitState:
          pending.get(node)?.question === label
            ? "unconfirmed"
            : evidence.value
              ? "confirmed"
              : evidence.readable
                ? "empty"
                : "unknown",
      };
    }
    function activate(list, option, click) {
      const label = text(option.textContent),
        previous = list ? value(list) : "";
      JobsDiagnostics?.note("option_clicked", list || option, label);
      if (click) click();
      else JobsPageActions.click(option);
      if (list) {
        const evidence = status(list);
        if (
          evidence.readable &&
          normalize(evidence.value) === normalize(label)
        ) {
          pending.delete(list);
          JobsDiagnostics?.note("option_verified", list, label);
        } else {
          pending.set(list, {
            question: question(list),
            answer: label,
            previous,
          });
          JobsDiagnostics?.note("option_unconfirmed", list, label);
        }
      }
      return option;
    }
    // One transaction: the caller's rule picks one of the listed labels, that
    // option is clicked and the page's committed choice is verified.
    async function chooseOptions(
      node,
      pickLabel,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
      } = /** @type {{canProceed?: () => boolean, replace?: boolean}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (!isControl(node) || typeof pickLabel !== "function") return null;
      const label = question(node),
        url = node.ownerDocument.location.href,
        previous = value(node);
      const current = () =>
        JobsPageActions.live(canProceed) &&
        visible(node) &&
        question(node) === label &&
        node.ownerDocument.location.href === url &&
        !describe(node)?.disabled;
      if (
        !current() ||
        (previous && !replace) ||
        (pending.get(node)?.question === label && !replace)
      )
        return null;
      const candidates = options(node).filter(enabled),
        labels = candidates.map((option) => text(option.textContent));
      const picked = labels.length ? pickLabel(labels) : null,
        matches = picked
          ? candidates.filter((option) => text(option.textContent) === picked)
          : [];
      if (matches.length !== 1 || !current()) return null;
      activate(node, matches[0]);
      const accepted = await JobsDOMWait.until(
        () =>
          current()
            ? status(node).readable &&
              normalize(value(node)) === normalize(picked)
            : cancelled,
        { root: node.ownerDocument, timeout: 1500 },
      );
      if (accepted && accepted !== cancelled && current()) {
        pending.delete(node);
        return node;
      }
      return null;
    }
    // An exact answer picks its one equal label.

    async function readOptions(
      node,
      canProceed = /** @type {() => boolean} */ (() => true),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      return JobsPageActions.live(canProceed) &&
        isControl(node) &&
        visible(node) &&
        !describe(node).disabled
        ? cachedOptions(node)
        : [];
    }
    // Every entrance (a binding, a known answer, AI, remote review)
    // ends here: record what was asked and what the control holds afterwards.

    // The only public component transaction. Selection belongs to the caller;
    // this component exposes page facts, commits the selection and reads it back.
    async function chooseFrom(node, pick, options = {}) {
      return chooseOptions(node, pick, options);
    }
    JobsDisclosureControls = {
      find,
      isControl,
      describe,
      value,
      cachedOptions,
      readOptions,
      chooseFrom,
    };
  })();
}
