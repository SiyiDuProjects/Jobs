import { JobsDiagnostics } from "./diagnostics.js";
import { JobsPageActions } from "./page-actions.js";
import { JobsDOMWait } from "./dom-wait.js";
import { JobsControlFields } from "./control-fields.js";

export var JobsMenuControls;
let initialized = false;
export function initializeMenuControls() {
  if (initialized) return;
  initialized = true;
  // Menu-backed controls (ADP, BambooHR, Dayforce). Every caller shares one
  // operation: a unique exact candidate and an actual committed value, never
  // editable search text.
  (() => {
    const text = (value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const normalize = (value) => text(value).normalize("NFKC").toLowerCase();
    const cache = new WeakMap(),
      pending = new WeakMap(),
      cancelled = {};
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
    const bambooSelector = '[data-menu-id][aria-haspopup="true"]';
    function kind(node) {
      if (!node?.matches) return null;
      if (
        node.matches(bambooSelector) &&
        node.matches('button,[role="button"]')
      )
        return "bamboo-menu";
      if (
        node.matches("div.input-container") &&
        (node.closest(
          ".personal-step-container,.applicationvsid-main-container",
        ) ||
          /(^|\.)adp\.com$/.test(node.ownerDocument.location.hostname))
      )
        return "adp-menu";
      if (
        node.matches('input[role="combobox"]') &&
        (node.hasAttribute("aria-controls") ||
          node.hasAttribute("aria-owns")) &&
        !node.closest("div.input-container") &&
        (node.closest(".ant-select") ||
          node.id.startsWith("jobPostingApplication_") ||
          /(^|\.)dayforcehcm\.com$/.test(node.ownerDocument.location.hostname))
      )
        return "dayforce-menu";
      return null;
    }
    const isControl = (node) => !!kind(node);
    function find(scope = document) {
      return [
        scope,
        ...scope.querySelectorAll(
          bambooSelector + ',div.input-container,input[role="combobox"]',
        ),
      ].filter((node) => isControl(node) && visible(node));
    }
    function host(node, type = kind(node)) {
      if (type === "dayforce-menu")
        return node.closest(".ant-select") || node.parentElement;
      if (type === "adp-menu") return node;
      return node.closest('[class*="multiSelect"]') || node.parentElement;
    }
    function backing(node) {
      let scope = host(node);
      for (
        let depth = 0;
        scope && depth < 3 && !scope.matches("form,body");
        depth++, scope = scope.parentElement
      ) {
        const selects = [...scope.querySelectorAll("select")],
          triggers = find(scope);
        if (
          selects.length === 1 &&
          triggers.length === 1 &&
          triggers[0] === node
        )
          return selects[0];
        if (selects.length > 1 || triggers.length > 1) break;
      }
      return null;
    }
    function question(node) {
      const doc = node.ownerDocument,
        linked = text(node.getAttribute("aria-labelledby"))
          .split(" ")
          .filter(Boolean)
          .map((id) => doc.getElementById(id)?.textContent || "")
          .join(" ");
      const native = backing(node),
        input = node.matches("input")
          ? node
          : node.querySelector('input:not([type="hidden"])');
      const direct =
        linked ||
        node.getAttribute("aria-label") ||
        [...(native?.labels || []), ...(input?.labels || [])]
          .map((label) => label.textContent)
          .join(" ");
      if (direct) return text(direct);
      const field =
        node.closest(
          ".ant-form-item,.form-field,.field,[data-field],.form-group",
        ) || host(node)?.parentElement;
      return text(
        field?.querySelector('label,legend,[class*="label"]')?.textContent,
      );
    }
    function linkedMenu(node, type = kind(node)) {
      const owner =
        type === "adp-menu"
          ? node.querySelector("[aria-controls],[aria-owns]") || node
          : node;
      const ids = text(
        type === "bamboo-menu"
          ? owner.getAttribute("data-menu-id")
          : owner.getAttribute("aria-owns") ||
              owner.getAttribute("aria-controls"),
      )
        .split(" ")
        .filter(Boolean);
      const menus = ids
        .map((id) => node.ownerDocument.getElementById(id))
        .filter(Boolean);
      return menus.length === 1 ? menus[0] : null;
    }
    const menuNodes = (doc) =>
      [...doc.querySelectorAll('[role="listbox"],[role="menu"]')].filter(
        visible,
      );
    function menuFor(node, type, before) {
      const linked = linkedMenu(node, type);
      if (linked) return linked;
      if (type !== "adp-menu") return null;
      const contained = [...node.querySelectorAll('[role="listbox"]')].filter(
        visible,
      );
      if (contained.length === 1) return contained[0];
      const opened = menuNodes(node.ownerDocument).filter(
        (menu) => !before?.has(menu),
      );
      return opened.length === 1 ? opened[0] : null;
    }
    function committed(node) {
      const native = backing(node);
      if (native && !native.multiple) {
        const selected = native.selectedOptions[0];
        return {
          value:
            native.value && !["-1", "-999"].includes(native.value)
              ? text(selected?.textContent)
              : "",
          readable: true,
        };
      }
      const box = host(node),
        marker = box?.querySelector(
          '.select__single-value,[class*="singleValue"],.single-value,.ant-select-selection-item,[data-selected-label]',
        );
      if (marker)
        return {
          value: text(
            marker.getAttribute("data-selected-label") || marker.textContent,
          ),
          readable: true,
        };
      const display = node.matches("input[readonly]")
        ? node
        : box?.querySelector('input[readonly]:not([type="hidden"])');
      if (display) return { value: text(display.value), readable: true };
      // Ant Select leaves its editable input empty after selection; its separate
      // selection-item is the committed label. The absence of that item is empty.
      if (box?.matches(".ant-select")) return { value: "", readable: true };
      return { value: "", readable: false };
    }
    const value = (node) => committed(node).value;
    function cachedOptions(node) {
      const entry = cache.get(node);
      return entry &&
        entry.url === node.ownerDocument.location.href &&
        entry.question === question(node) &&
        entry.host === host(node)
        ? entry.options
        : undefined;
    }
    function describe(node) {
      const type = kind(node);
      if (!type) return null;
      const native = backing(node),
        box = host(node),
        menu = linkedMenu(node),
        label = question(node),
        status = committed(node);
      const attempted = pending.get(node);
      if (
        attempted?.question === label &&
        status.readable &&
        status.value &&
        (normalize(status.value) === normalize(attempted.answer) ||
          status.value !== attempted.previous)
      )
        pending.delete(node);
      const group = [
        ...new Set(
          [
            node,
            native,
            ...(box?.querySelectorAll('input,select,[role="combobox"]') || []),
            menu,
            ...(menu?.querySelectorAll('[role="option"],[role="menuitem"]') ||
              []),
          ].filter(Boolean),
        ),
      ];
      const required =
        group.some(
          (item) =>
            item.required || item.getAttribute("aria-required") === "true",
        ) || /\*\s*$/.test(label);
      const requiredKnown =
        required ||
        !!native ||
        group.some((item) => item.hasAttribute("aria-required")) ||
        /\boptional\b/i.test(label);
      const disabled =
        !!node.disabled ||
        !!native?.disabled ||
        node.getAttribute("aria-disabled") === "true" ||
        !!node.closest(".ant-select-disabled");
      return {
        type: "combobox",
        component: type,
        question: label,
        value: status.value,
        readable: status.readable,
        group,
        required,
        requiredKnown,
        disabled,
        invalid: group.some(
          (item) =>
            item.getAttribute("aria-invalid") === "true" ||
            (item.willValidate &&
              !item.validity.valid &&
              !(status.value && item !== native && item.matches("input"))),
        ),
        supported: !!label && !disabled,
        options: cachedOptions(node),
        commitState:
          pending.get(node)?.question === label
            ? "unconfirmed"
            : status.value
              ? "confirmed"
              : status.readable
                ? "empty"
                : "unknown",
      };
    }
    const note = (type, node, detail) =>
      JobsDiagnostics?.note(type, node, detail);
    function mouse(node) {
      const view = node.ownerDocument.defaultView;
      for (const type of ["mouseover", "mousedown", "mouseup", "click"])
        JobsPageActions.dispatch(
          node,
          new view.MouseEvent(type, { bubbles: true, cancelable: true, view }),
        );
    }
    function press(node, key) {
      const view = node.ownerDocument.defaultView;
      for (const type of ["keydown", "keypress", "keyup"])
        JobsPageActions.dispatch(
          node,
          new view.KeyboardEvent(type, {
            key,
            code: key,
            keyCode: key === "Enter" ? 13 : 27,
            bubbles: true,
            cancelable: true,
          }),
        );
    }
    function context(node, canProceed) {
      canProceed = JobsPageActions.guard(canProceed);
      const url = node.ownerDocument.location.href,
        label = question(node),
        box = host(node),
        native = backing(node);
      const owner = node.querySelector?.("[aria-controls],[aria-owns]") || node;
      const link =
        owner.getAttribute("data-menu-id") ||
        owner.getAttribute("aria-owns") ||
        owner.getAttribute("aria-controls");
      let edited = false,
        sending = false;
      const edit = (event) => {
        if (event.isTrusted && !sending) edited = true;
      };
      node.addEventListener("input", edit);
      native?.addEventListener("change", edit);
      return {
        current: () =>
          JobsPageActions.live(canProceed) &&
          !edited &&
          node.isConnected &&
          node.ownerDocument.location.href === url &&
          question(node) === label &&
          host(node) === box &&
          backing(node) === native &&
          visible(node) &&
          !node.disabled &&
          !native?.disabled &&
          node.getAttribute("aria-disabled") !== "true" &&
          (!link ||
            (owner.getAttribute("data-menu-id") ||
              owner.getAttribute("aria-owns") ||
              owner.getAttribute("aria-controls")) === link),
        perform: (action) => {
          sending = true;
          try {
            return action();
          } finally {
            sending = false;
          }
        },
        close: () => {
          node.removeEventListener("input", edit);
          native?.removeEventListener("change", edit);
        },
      };
    }
    async function until(node, read, current, timeout = 5000) {
      const result = await JobsDOMWait.until(
        () => (current() ? read() : cancelled),
        { root: node.ownerDocument, timeout },
      );
      return current() && result !== cancelled ? result : null;
    }
    // Each menu kind's opener: Bamboo opens on Enter once focused (its handler
    // attaches after focus, so an Enter that opens nothing is pressed once more),
    // Dayforce types the search term, others are clicked.
    async function open(
      node,
      type,
      query,
      current,
      before,
      perform = (action) => action(),
    ) {
      if (!current()) return false;
      if (type === "bamboo-menu") {
        perform(() => node.focus());
        for (let attempt = 0; attempt < 2 && current(); attempt++) {
          perform(() => press(node, "Enter"));
          if (
            await until(
              node,
              () => visible(menuFor(node, type, before)) || null,
              current,
              400,
            )
          )
            break;
        }
      } else if (
        type === "dayforce-menu" &&
        !node.hasAttribute("readonly") &&
        query != null
      )
        await perform(() =>
          JobsControlFields.writeText(node, String(query), {
            blur: false,
            keyboard: true,
            click: true,
            canProceed: current,
          }),
        );
      else perform(() => mouse(node));
      return current();
    }
    function candidateNodes(menu, type) {
      if (!menu) return [];
      const selector =
        type === "bamboo-menu"
          ? '[role="menuitem"]'
          : type === "dayforce-menu"
            ? 'div[role="option"]'
            : menu.querySelector('[role="option"],li')
              ? '[role="option"],li'
              : "div";
      return [...menu.querySelectorAll(selector)].filter(
        (option) =>
          visible(option) &&
          option.getAttribute("aria-disabled") !== "true" &&
          !option.disabled &&
          text(option.textContent),
      );
    }
    // An exact answer picks its one equal label.
    const exactly = (answer) => (labels) => {
      const same = labels.filter(
        (label) => normalize(label) === normalize(answer),
      );
      return same.length === 1 ? same[0] : null;
    };
    async function candidates(node, type, before, current) {
      return (
        (await until(
          node,
          () => {
            const popup = menuFor(node, type, before);
            if (!popup || !visible(popup)) return null;
            const found = candidateNodes(popup, type);
            return found.length ? found : null;
          },
          current,
        )) || []
      );
    }
    // One transaction: open the menu (a search types its term), read its
    // options, let the caller's rule pick one label, click that option in the
    // same open menu and verify the commit. Options are listed and searched once.
    async function transaction(
      node,
      pickLabel,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
        query,
        type = kind(node),
      } = /** @type {{canProceed?: () => boolean, replace?: boolean, query?: string, type?: string}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (!node || !type || typeof pickLabel !== "function") return null;
      const life = context(node, canProceed),
        previous = value(node),
        before = new Set(menuNodes(node.ownerDocument));
      const current = () => life.current() && value(node) === previous;
      try {
        if (!current() || (previous && !replace)) return null;
        if (!(await open(node, type, query, current, before, life.perform)))
          return null;
        const found = await candidates(node, type, before, current);
        if (!current()) return null;
        const labels = found.map((option) => text(option.textContent));
        if (
          labels.length &&
          labels.length <= 150 &&
          new Set(labels.map(normalize)).size === labels.length
        )
          cache.set(node, {
            host: host(node),
            question: question(node),
            url: node.ownerDocument.location.href,
            options: labels.map((label) => ({ value: label, label })),
          });
        const label = labels.length ? pickLabel(labels) : null;
        const matches = label
          ? found.filter((option) => text(option.textContent) === label)
          : [];
        if (matches.length !== 1 || !current() || !visible(matches[0]))
          return null;
        const option = matches[0],
          expected = text(option.textContent);
        note("option_clicked", node, expected);
        await life.perform(async () => {
          if (type === "adp-menu") mouse(option);
          else JobsPageActions.click(option);
        });
        const accepted = await until(
          node,
          () =>
            committed(node).readable &&
            normalize(value(node)) === normalize(expected),
          life.current,
          1500,
        );
        if (accepted) {
          pending.delete(node);
          note("option_verified", node, expected);
          return node;
        }
        pending.set(node, {
          question: question(node),
          answer: expected,
          previous,
        });
        note("option_unconfirmed", node, expected);
        return null;
      } finally {
        // A menu opened here and not answered is closed without choosing.
        if (current() && !before.has(menuFor(node, type, before)))
          press(node, "Escape");
        life.close();
      }
    }
    const chooseOptions = (
      node,
      pickLabel,
      {
        canProceed,
        replace = false,
        query,
      } = /** @type {{canProceed?: () => boolean, replace?: boolean, query?: string}} */ ({}),
    ) => transaction(node, pickLabel, { canProceed, replace, query });

    async function readOptions(
      node,
      canProceed = /** @type {() => boolean} */ (() => true),
      { answer } = /** @type {{answer?: string}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      const type = kind(node);
      if (!type) return [];
      const life = context(node, canProceed),
        previous = value(node),
        before = new Set(menuNodes(node.ownerDocument));
      const current = () => life.current() && value(node) === previous;
      try {
        if (!(await open(node, type, answer, current, before, life.perform)))
          return [];
        const found = await candidates(node, type, before, current);
        const labels = found.map((option) => text(option.textContent));
        if (
          !current() ||
          !labels.length ||
          labels.length > 150 ||
          new Set(labels.map(normalize)).size !== labels.length
        )
          return [];
        const answers = labels.map((label) => ({ value: label, label }));
        cache.set(node, {
          host: host(node),
          question: question(node),
          url: node.ownerDocument.location.href,
          options: answers,
        });
        return answers;
      } finally {
        if (current() && !before.has(menuFor(node, type, before)))
          press(node, "Escape");
        life.close();
      }
    }
    // Every entrance (a binding, a known answer, AI, remote review)
    // ends here: record what was asked and what the control holds afterwards.

    // The only public component transaction. Selection belongs to the caller;
    // this component exposes page facts, commits the selection and reads it back.
    async function chooseFrom(node, pick, options = {}) {
      return chooseOptions(node, pick, options);
    }
    JobsMenuControls = {
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
