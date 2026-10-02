import { JobsPageActions } from "./page-actions.js";
import { JobsDOMWait } from "./dom-wait.js";
import { JobsDiagnostics } from "./diagnostics.js";

export var JobsSuccessFactorsControls;
let initialized = false;
export function initializeSuccessfactorsControls() {
  if (initialized) return;
  initialized = true;
  // SuccessFactors paged selectContainer controls, read and written through the
  // shared scanner/writer.
  (() => {
    const state = new WeakMap();
    const text = (value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const normalized = (value) => text(value).toLowerCase();
    const noSelection = (value) => /no selection/i.test(value);
    function owner(input) {
      return input?.closest?.('div[id*="selectContainer"]');
    }
    function isControl(input) {
      return (
        !!input?.matches?.(
          'input:not([type="hidden"]):not([type="password"])',
        ) &&
        /^\d+(?::|$)/.test(input.id) &&
        !!owner(input)
      );
    }
    function record(input) {
      if (!state.has(input)) {
        const entry = { revision: 0, committed: null, writing: false };
        // A search query must never retain an earlier committed value. This also
        // invalidates operations when another actor edits while pages are loading.
        input.addEventListener("input", () => {
          if (!entry.writing) {
            entry.committed = null;
            entry.options = undefined;
            entry.revision++;
          }
        });
        state.set(input, entry);
      }
      return state.get(input);
    }
    const listId = (input) =>
      `${Number.parseInt(input.id, 10) + 1}:_listSelect`;
    function optionLabel(option) {
      return text(
        option.querySelector("a")?.getAttribute("title") || option.textContent,
      );
    }
    function lists(input) {
      return [...input.ownerDocument.querySelectorAll("ul[id]")].filter(
        (list) => list.id === listId(input),
      );
    }
    function selected(input) {
      if (!isControl(input)) return "";
      const chosen = lists(input).flatMap((list) => [
        ...list.querySelectorAll('li[role="option"][aria-selected="true"]'),
      ]);
      const labels = [
        ...new Set(
          chosen
            .map(optionLabel)
            .filter((label) => label && !noSelection(label)),
        ),
      ];
      return labels.length === 1 &&
        normalized(input.value) === normalized(labels[0])
        ? labels[0]
        : "";
    }
    function value(input) {
      if (!isControl(input)) return "";
      const entry = record(input),
        explicit = selected(input);
      if (explicit) return explicit;
      // Readonly display inputs cannot contain a user search query.
      if (input.readOnly)
        return noSelection(input.value) ? "" : text(input.value);
      return entry.committed &&
        input.value === entry.committed.raw &&
        owner(input) === entry.committed.owner
        ? entry.committed.label
        : "";
    }
    function question(input) {
      const doc = input.ownerDocument;
      const labelledBy = text(input.getAttribute("aria-labelledby"));
      if (labelledBy) {
        const label = text(
          labelledBy
            .split(" ")
            .map((id) => doc.getElementById(id)?.textContent || "")
            .join(" "),
        );
        if (label) return label;
      }
      const label = text(
        input.getAttribute("aria-label") ||
          [...(input.labels || [])].map((node) => node.textContent).join(" "),
      );
      if (label) return label;
      const field = owner(input)?.closest(".fieldComponentInput");
      const preceding = field?.previousElementSibling;
      return preceding?.matches("label") ? text(preceding.textContent) : "";
    }
    function requirement(input) {
      const container = owner(input),
        label = question(input);
      const explicit = [
        input,
        container,
        container?.closest(".fieldComponentInput"),
      ].filter(Boolean);
      if (
        explicit.some(
          (node) =>
            node.hasAttribute("required") ||
            node.getAttribute("aria-required") === "true",
        ) ||
        /\*\s*$/.test(label)
      )
        return { required: true, requiredKnown: true };
      if (
        explicit.some(
          (node) => node.getAttribute("aria-required") === "false",
        ) ||
        /\(optional\)\s*$/i.test(label)
      )
        return { required: false, requiredKnown: true };
      return { required: false, requiredKnown: false };
    }
    function find(scope) {
      const nodes = [
        ...(scope?.querySelectorAll?.('div[id*="selectContainer"] input') ||
          []),
      ];
      if (isControl(scope)) nodes.unshift(scope);
      return [...new Set(nodes.filter(isControl))];
    }
    function cachedOptions(input) {
      const entry = state.get(input);
      return entry?.question === question(input) &&
        entry.owner === owner(input) &&
        entry.url === input.ownerDocument.location.href
        ? entry.options
        : undefined;
    }
    function describe(input) {
      if (!isControl(input)) return null;
      return {
        type: "combobox",
        question: question(input),
        value: value(input),
        ...requirement(input),
        invalid:
          input.getAttribute("aria-invalid") === "true" ||
          owner(input).getAttribute("aria-invalid") === "true",
        supported: true,
        readable: true,
        disabled:
          input.disabled ||
          input.getAttribute("aria-disabled") === "true" ||
          owner(input).getAttribute("aria-disabled") === "true",
        group: [
          input,
          ...owner(input).querySelectorAll('input,button,[role="combobox"]'),
        ].filter(
          (node, index, all) =>
            all.indexOf(node) === index && (node === input || !isControl(node)),
        ),
        options: cachedOptions(input),
      };
    }
    function visible(input) {
      if (
        !input.isConnected ||
        input.closest('[hidden],[inert],[aria-hidden="true"]')
      )
        return false;
      for (let node = input; node?.nodeType === 1; node = node.parentElement) {
        const style = input.ownerDocument.defaultView.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden")
          return false;
      }
      return true;
    }
    function operation(input, canProceed) {
      canProceed = JobsPageActions.guard(canProceed);
      const entry = record(input),
        revision = ++entry.revision;
      const container = owner(input),
        id = input.id,
        url = input.ownerDocument.location.href;
      const label = question(input),
        before = input.value;
      let committing = false;
      const current = () =>
        entry.revision === revision &&
        JobsPageActions.live(canProceed) &&
        visible(input) &&
        isControl(input) &&
        owner(input) === container &&
        input.id === id &&
        input.ownerDocument.location.href === url &&
        question(input) === label &&
        !input.disabled &&
        input.getAttribute("aria-disabled") !== "true" &&
        container.getAttribute("aria-disabled") !== "true" &&
        (committing || input.value === before);
      return {
        entry,
        current,
        commit: () => {
          committing = true;
        },
        label,
        container,
        url,
      };
    }
    async function wait(input, read, current, timeout) {
      const result = await JobsDOMWait.until(
        () => (current() ? read() : { cancelled: true }),
        { root: input.ownerDocument, timeout },
      );
      return current() && !result?.cancelled ? result : null;
    }
    function click(node) {
      const run = () => {
        JobsPageActions.click(node);
        return node;
      };
      return JobsDiagnostics?.perform
        ? JobsDiagnostics.perform("click", () => node, run)
        : run();
    }
    // The list loads 100 options per page as it scrolls; each page is read after
    // scrolling to its end.
    async function walk(input, current, visit, timeout) {
      if (!current()) return { complete: false, cancelled: true };
      click(input);
      const scroller = await wait(
        input,
        () => {
          const list = input.ownerDocument.getElementById(listId(input));
          return list?.parentElement?.parentElement?.parentElement;
        },
        current,
        timeout,
      );
      if (!scroller) return { complete: false };
      let count = 100;
      for (let page = 0; count === 100 && page < 5; page++) {
        if (!current() || !scroller.isConnected)
          return { complete: false, cancelled: true };
        scroller.scrollTo(0, scroller.scrollHeight);
        const list = await wait(
          input,
          () => {
            const pageNode = input.ownerDocument.getElementById(
              `${Number.parseInt(input.id, 10) + 1}:${page}`,
            );
            const found = [
              ...(pageNode?.querySelectorAll("ul[id]") || []),
            ].find((node) => node.id === listId(input));
            return found &&
              found.getAttribute("aria-busy") !== "true" &&
              pageNode.getAttribute("aria-busy") !== "true"
              ? found
              : null;
          },
          current,
          timeout,
        );
        if (!list) return { complete: false };
        count = list.childElementCount;
        JobsDiagnostics?.note(
          "auto_options_page",
          input,
          JSON.stringify({ component: "successfactors-paged", page, count }),
        );
        visit([...list.querySelectorAll('li[role="option"]')]);
      }
      return { complete: count !== 100 };
    }
    function allowed(option) {
      return (
        option.getAttribute("aria-disabled") !== "true" &&
        !option.hasAttribute("disabled") &&
        !noSelection(optionLabel(option))
      );
    }
    async function collect(input, op, timeout) {
      const options = [];
      const result = await walk(
        input,
        op.current,
        (nodes) => {
          options.push(...nodes.filter(allowed));
        },
        timeout,
      );
      return { ...result, options };
    }
    function saveOptions(input, op, nodes) {
      const labels = nodes.map(optionLabel).filter(Boolean);
      const options =
        labels.length === nodes.length &&
        new Set(labels.map(normalized)).size === labels.length
          ? labels.map((label) => ({ value: label, label }))
          : [];
      Object.assign(op.entry, {
        options,
        question: op.label,
        owner: op.container,
        url: op.url,
      });
      return options;
    }
    async function readOptions(
      input,
      canProceed = /** @type {() => boolean} */ (() => true),
      context = {},
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (!isControl(input)) return [];
      const op = operation(input, canProceed);
      const collected = await collect(input, op, context.timeout ?? 3000);
      if (!collected.complete || !op.current()) {
        op.entry.options = undefined;
        return [];
      }
      return saveOptions(input, op, collected.options);
    }
    async function commit(input, option, op, timeout) {
      if (!op.current() || !option.isConnected) return null;
      const label = optionLabel(option),
        before = input.value,
        view = input.ownerDocument.defaultView;
      op.commit();
      op.entry.writing = true;
      try {
        click(option);
        JobsPageActions.dispatch(
          input,
          new view.InputEvent("input", { bubbles: true, cancelable: true }),
        );
        JobsPageActions.dispatch(
          input,
          new view.Event("change", { bubbles: true }),
        );
        input.blur();
        JobsPageActions.dispatch(
          option,
          new view.Event("change", { bubbles: true }),
        );
        option.blur();
      } finally {
        op.entry.writing = false;
      }
      const accepted = () =>
        normalized(input.value) === normalized(label) &&
        input.getAttribute("aria-invalid") !== "true" &&
        (input.value !== before ||
          normalized(selected(input)) === normalized(label));
      if (!(await wait(input, accepted, op.current, timeout))) return null;
      op.entry.committed = { label, raw: input.value, owner: owner(input) };
      return input;
    }
    // One transaction: the paged list is read once, the caller's rule picks
    // one label from the complete list, and that option is committed.
    async function chooseOptions(
      input,
      pickLabel,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
        timeout = 3000,
      } = /** @type {{canProceed?: () => boolean, replace?: boolean, timeout?: number}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (!isControl(input) || typeof pickLabel !== "function") return null;
      const op = operation(input, canProceed);
      if (!op.current() || (value(input) && !replace)) return null;
      const collected = await collect(input, op, timeout);
      if (!collected.complete || !op.current()) return null;
      saveOptions(input, op, collected.options);
      const labels = collected.options.map(optionLabel),
        label = labels.length ? pickLabel(labels) : null;
      const matches = label
        ? collected.options.filter((option) => optionLabel(option) === label)
        : [];
      return matches.length === 1
        ? commit(input, matches[0], op, timeout)
        : null;
    }
    // An exact answer picks its one equal label.

    // Every entrance (a binding, a known answer, AI, remote review)
    // ends here: record what was asked and what the control holds afterwards.

    // The only public component transaction. Selection belongs to the caller;
    // this component exposes page facts, commits the selection and reads it back.
    async function chooseFrom(node, pick, options = {}) {
      return chooseOptions(node, pick, options);
    }
    JobsSuccessFactorsControls = Object.freeze({
      find,
      isControl,
      describe,
      value,
      cachedOptions,
      readOptions,
      chooseFrom,
    });
  })();
}
