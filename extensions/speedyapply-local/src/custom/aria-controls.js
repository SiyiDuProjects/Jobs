import { JobsPageActions } from "./page-actions.js";
import { JobsDOMWait } from "./dom-wait.js";
import { JobsControlFields } from "./control-fields.js";

export var JobsAriaControls;
let initialized = false;
export function initializeAriaControls() {
  if (initialized) return;
  initialized = true;
  // Standard ARIA comboboxes and listbox buttons that no site component owns.
  // The fallback reads the linked listbox's options, clicks exactly one matching
  // option and accepts it only when the control then displays that option.
  // Typing is only a search query; free text is never committed as an answer.
  (() => {
    const text = (value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const normalize = (value) => text(value).normalize("NFKC").toLowerCase();
    const prompt =
      /^(?:[-—–\s]*(?:select|choose|please (?:select|choose)|select (?:one|an option)|choose (?:one|an option)|none selected)[\s.…:]*[-—–\s]*)?$/i;
    const cache = new WeakMap(),
      pending = new WeakMap(),
      cancelled = {};
    const act = () => JobsPageActions;
    function visible(node) {
      if (
        !node?.isConnected ||
        node.closest('[hidden],[inert],[aria-hidden="true"]')
      )
        return false;
      for (
        let current = node;
        current?.nodeType === 1;
        current = current.parentElement
      ) {
        const style = node.ownerDocument.defaultView.getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden")
          return false;
      }
      return true;
    }
    function isControl(node) {
      if (
        !node?.matches ||
        node.matches('select,input[type="hidden"],input[type="password"]')
      )
        return false;
      return node.matches('[role="combobox"],button[aria-haspopup="listbox"]');
    }
    // ARIA 1.0 puts role=combobox on a wrapper around the actual textbox.
    const textbox = (node) =>
      node.matches("input,textarea")
        ? node
        : node.querySelector('input:not([type="hidden"]),textarea');
    const ids = (node) =>
      [node, textbox(node)]
        .filter(Boolean)
        .flatMap((item) =>
          text(
            item.getAttribute("aria-controls") ||
              item.getAttribute("aria-owns"),
          ).split(" "),
        )
        .filter(Boolean);
    function linked(node) {
      const found = [
        ...new Set(
          ids(node)
            .map((id) => node.ownerDocument.getElementById(id))
            .filter(Boolean),
        ),
      ].filter(
        (item) =>
          item.matches('[role="listbox"]') ||
          item.querySelector('[role="option"]'),
      );
      return found.length === 1 ? found[0] : null;
    }
    const listboxes = (doc) =>
      [...doc.querySelectorAll('[role="listbox"]')].filter(visible);
    function popup(node, before) {
      const own = linked(node);
      if (own) return visible(own) ? own : null;
      const opened = listboxes(node.ownerDocument).filter(
        (item) => !before?.has(item),
      );
      return opened.length === 1 ? opened[0] : null;
    }
    const multiple = (node) =>
      linked(node)?.getAttribute("aria-multiselectable") === "true";
    // The same label sources as the common scanner; no guessing from nearby
    // containers. An unlabelled control stays unsupported.
    function question(node) {
      const doc = node.ownerDocument,
        input = textbox(node);
      const labelled = [node, input]
        .filter(Boolean)
        .map((item) =>
          text(item.getAttribute("aria-labelledby"))
            .split(" ")
            .filter(Boolean)
            .map((id) => doc.getElementById(id)?.textContent || "")
            .join(" "),
        )
        .find((item) => text(item));
      const direct =
        labelled ||
        node.getAttribute("aria-label") ||
        input?.getAttribute("aria-label") ||
        [...(node.labels || []), ...(input?.labels || [])]
          .map((label) => label.textContent)
          .join(" ");
      return text(
        direct ||
          node.closest("fieldset")?.querySelector(":scope > legend")
            ?.textContent ||
          input?.getAttribute("placeholder"),
      );
    }
    function value(node) {
      const input = textbox(node);
      if (input) return text(input.value);
      const copy = node.cloneNode(true);
      copy
        .querySelectorAll('[role="listbox"],svg,[aria-hidden="true"]')
        .forEach((child) => child.remove());
      const shown = text(copy.textContent);
      return prompt.test(shown) ? "" : shown;
    }
    const expanded = (node) =>
      [node, textbox(node)].some(
        (item) => item?.getAttribute("aria-expanded") === "true",
      );
    function cachedOptions(node) {
      const entry = cache.get(node);
      return entry &&
        entry.url === node.ownerDocument.location.href &&
        entry.question === question(node)
        ? entry.options
        : undefined;
    }
    function describe(node) {
      if (!isControl(node)) return null;
      const input = textbox(node),
        menu = linked(node),
        label = question(node),
        current = expanded(node) ? "" : value(node);
      const attempt = pending.get(node);
      if (
        attempt &&
        current &&
        normalize(current) === normalize(attempt.answer)
      )
        pending.delete(node);
      const group = [
        ...new Set(
          [
            node,
            input,
            menu,
            ...(menu?.querySelectorAll('[role="option"]') || []),
          ].filter(Boolean),
        ),
      ];
      const required =
        group.some(
          (item) =>
            item.required || item.getAttribute("aria-required") === "true",
        ) || /\*\s*$/.test(label);
      const disabled = group.some(
        (item) =>
          item.disabled || item.getAttribute("aria-disabled") === "true",
      );
      return {
        type: "combobox",
        component: "aria-combobox",
        question: label,
        value: current,
        readable: true,
        group,
        required,
        requiredKnown:
          required ||
          group.some((item) => item.hasAttribute("aria-required")) ||
          /\boptional\b/i.test(label),
        disabled,
        invalid: group.some(
          (item) => item.getAttribute("aria-invalid") === "true",
        ),
        supported: !!label && !disabled && !multiple(node),
        options: cachedOptions(node),
        commitState: pending.get(node)
          ? "unconfirmed"
          : current
            ? "confirmed"
            : "empty",
      };
    }
    function mouse(node) {
      const view = node.ownerDocument.defaultView;
      for (const type of ["mousedown", "mouseup", "click"])
        act().dispatch(
          node,
          new view.MouseEvent(type, { bubbles: true, cancelable: true, view }),
        );
    }
    function press(node, key) {
      const view = node.ownerDocument.defaultView;
      for (const type of ["keydown", "keyup"])
        act().dispatch(
          node,
          new view.KeyboardEvent(type, {
            key,
            code: key,
            bubbles: true,
            cancelable: true,
          }),
        );
    }
    function context(node, canProceed) {
      canProceed = act().guard(canProceed);
      const url = node.ownerDocument.location.href,
        label = question(node);
      let edited = false,
        sending = false;
      const edit = (event) => {
        if (event.isTrusted && !sending) edited = true;
      };
      node.addEventListener("input", edit, true);
      return {
        current: () =>
          act().live(canProceed) &&
          !edited &&
          node.isConnected &&
          visible(node) &&
          node.ownerDocument.location.href === url &&
          question(node) === label &&
          !node.disabled &&
          node.getAttribute("aria-disabled") !== "true",
        perform: (action) => {
          sending = true;
          try {
            return action();
          } finally {
            sending = false;
          }
        },
        close: () => node.removeEventListener("input", edit, true),
      };
    }
    async function until(node, read, current, timeout) {
      const result = await JobsDOMWait.until(
        () => (current() ? read() : cancelled),
        { root: node.ownerDocument, timeout },
      );
      return current() && result !== cancelled ? result : null;
    }
    const optionNodes = (menu) =>
      [...(menu?.querySelectorAll('[role="option"]') || [])].filter(
        (option) =>
          visible(option) &&
          option.getAttribute("aria-disabled") !== "true" &&
          text(option.textContent),
      );
    // Open the popup; for a searchable textbox with no initial list, type the
    // query to retrieve candidates. Reports whether a query was typed.
    async function candidates(node, query, life, before) {
      const input = textbox(node);
      if (!expanded(node)) {
        life.perform(() => {
          (input || node).focus();
          mouse(node);
        });
        if (input && !expanded(node))
          life.perform(() => press(input, "ArrowDown"));
      }
      // An open but empty searchable list is waiting for a query; do not wait
      // out the timeout before typing it.
      const open = popup(node, before),
        searchable = query && input && !input.readOnly && !input.value;
      const read = () => {
        const found = optionNodes(popup(node, before));
        return found.length ? found : null;
      };
      let found =
          open && !optionNodes(open).length && searchable
            ? null
            : await until(node, read, life.current, 1500),
        typed = false;
      if (!found && searchable) {
        typed = !!(await life.perform(() =>
          JobsControlFields.writeText(input, String(query), {
            blur: false,
            canProceed: life.current,
          }),
        ));
        if (typed) found = await until(node, read, life.current, 3000);
      }
      return { found: found || [], typed };
    }
    async function close(node, typed) {
      if (expanded(node)) press(textbox(node) || node, "Escape");
      // A search query left in the textbox would read as an answer.
      const input = textbox(node);
      if (typed && input?.value)
        await JobsControlFields.writeText(input, "", { blur: false });
    }
    async function readOptions(
      node,
      canProceed = /** @type {() => boolean} */ (() => true),
      { answer } = /** @type {{answer?: string}} */ ({}),
    ) {
      if (!isControl(node)) return [];
      const life = context(node, canProceed),
        before = new Set(listboxes(node.ownerDocument)),
        previous = value(node);
      let typed = false;
      try {
        if (!life.current() || previous) return [];
        const result = await candidates(node, answer, life, before),
          found = result.found;
        typed = result.typed;
        const labels = found.map((option) => text(option.textContent));
        if (
          !life.current() ||
          !labels.length ||
          labels.length > 150 ||
          new Set(labels.map(normalize)).size !== labels.length
        )
          return [];
        const options = labels.map((label) => ({ value: label, label }));
        cache.set(node, {
          url: node.ownerDocument.location.href,
          question: question(node),
          options,
        });
        return options;
      } finally {
        if (life.current()) await close(node, typed);
        life.close();
      }
    }
    // One transaction: open the list (a search types its term once), let the
    // caller's rule pick one label, click that option in the same list and
    // verify the page shows it.
    async function chooseOptions(
      node,
      pickLabel,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
        query,
      } = /** @type {{canProceed?: () => boolean, replace?: boolean, query?: string}} */ ({}),
    ) {
      if (!isControl(node) || multiple(node) || typeof pickLabel !== "function")
        return null;
      const life = context(node, canProceed),
        before = new Set(listboxes(node.ownerDocument)),
        previous = value(node);
      try {
        if (!life.current() || (previous && !replace)) return null;
        const { found, typed } = await candidates(node, query, life, before);
        const labels = found.map((option) => text(option.textContent)),
          label = labels.length ? pickLabel(labels) : null;
        if (
          labels.length &&
          labels.length <= 150 &&
          new Set(labels.map(normalize)).size === labels.length
        )
          cache.set(node, {
            url: node.ownerDocument.location.href,
            question: question(node),
            options: labels.map((label) => ({ value: label, label })),
          });
        const matches = label
          ? found.filter((option) => text(option.textContent) === label)
          : [];
        if (!life.current() || matches.length !== 1) {
          if (life.current()) await close(node, typed);
          return null;
        }
        const expected = text(matches[0].textContent);
        life.perform(() => mouse(matches[0]));
        const accepted = await until(
          node,
          () =>
            !expanded(node) && normalize(value(node)) === normalize(expected),
          life.current,
          1500,
        );
        if (accepted) {
          pending.delete(node);
          return node;
        }
        pending.set(node, { answer: expected });
        return null;
      } finally {
        life.close();
      }
    }
    // An exact answer picks its one equal label.

    // The only public component transaction. Selection belongs to the caller;
    // this component exposes page facts, commits the selection and reads it back.
    async function chooseFrom(node, pick, options = {}) {
      return chooseOptions(node, pick, options);
    }
    JobsAriaControls = Object.freeze({
      isControl,
      describe,
      value,
      cachedOptions,
      readOptions,
      chooseFrom,
      multiple,
    });
  })();
}
