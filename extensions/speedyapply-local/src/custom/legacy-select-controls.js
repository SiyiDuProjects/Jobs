import { JobsPageActions } from "./page-actions.js";
import { JobsDOMWait } from "./dom-wait.js";
import { JobsDiagnostics } from "./diagnostics.js";
import { JobsControlFields } from "./control-fields.js";

export var JobsLegacySelectControls;
let initialized = false;
export function initializeLegacySelectControls() {
  if (initialized) return;
  initialized = true;
  // ATS search/select widgets (Pinpoint, Rippling, Lever, Seek, Greenhouse
  // legacy, Ashby location). Matching policy belongs to the caller; opening,
  // typing and committing have one owner.
  (() => {
    const states = new WeakMap();
    const text = (value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const normal = (value) => text(value).toLowerCase();
    const xpath = (doc, expression) =>
      doc.evaluate(
        expression,
        doc,
        null,
        doc.defaultView.XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      ).singleNodeValue;
    const xpathAll = (doc, expression) => {
      const result = doc.evaluate(
        expression,
        doc,
        null,
        doc.defaultView.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );
      return Array.from({ length: result.snapshotLength }, (_, index) =>
        result.snapshotItem(index),
      );
    };
    const ashbyLocationXPath = `//label[@for='_systemfield_location']/following-sibling::input | //label[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'location')]/following-sibling::input[@aria-haspopup='listbox'] | //label[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'location')]/following-sibling::div/input[@aria-haspopup='listbox']`;
    function details(node) {
      if (!node?.matches) return null;
      const doc = node.ownerDocument,
        host = doc.location.hostname;
      if (
        /\.pinpointhq\.com$/.test(host) &&
        (node.matches(".react-select__control") ||
          (node.matches(
            ".react-select__placeholder,.react-select__single-value",
          ) &&
            !node.closest(".react-select__control")))
      )
        return {
          kind: "pinpoint",
          box: node.matches(".react-select__control")
            ? node.parentElement
            : node.parentElement.parentElement,
          input: node.querySelector("input"),
        };
      if (!node.matches('input:not([type="hidden"]):not([type="password"])'))
        return null;
      if (
        /(^|\.)greenhouse\.io$/.test(host) &&
        node.id === "auto_complete_input"
      )
        return { kind: "greenhouse-location", box: node, input: node };
      if (host === "ats.rippling.com") {
        const box = node.closest(
          '[data-testid="location"],[data-testid^="eeoc."],[data-testid="field"]',
        );
        if (box?.getAttribute("data-testid") === "location")
          return { kind: "rippling-location", box, input: node };
        if (box && node.getAttribute("role") === "combobox")
          return { kind: "rippling-search", box, input: node };
      }
      if (
        /\.rippling-ats\.com$/.test(host) &&
        node.closest(".Select") &&
        doc.getElementById(node.id + "_label")
      )
        return {
          kind: "rippling-legacy",
          box: node.closest(".Select"),
          input: node,
        };
      if (
        /(^|\.)greenhouse\.io$/.test(host) &&
        !node.id.endsWith("_search") &&
        node.closest(".select2-container")
      )
        return {
          kind: "greenhouse-legacy",
          box: node.closest(".select2-container"),
          input: node,
        };
      if (
        host === "jobs.ashbyhq.com" &&
        xpathAll(doc, ashbyLocationXPath).includes(node)
      )
        return {
          kind: "ashby-location",
          box:
            node.closest("fieldset,.ashby-application-form-field-entry") ||
            node.parentElement,
          input: node,
        };
      if (/(^|\.)lever\.co$/.test(host) && node.name === "location")
        return {
          kind: "lever-location",
          box: node.closest(".application-field") || node.parentElement,
          input: node,
        };
      if (
        /(^|\.)seek\.com\.au$/.test(host) &&
        node.matches('input[data-automation="current-location2"]')
      )
        return { kind: "seek-location", box: node.parentElement, input: node };
      return null;
    }
    const isControl = (node) => !!details(node);
    function find(scope) {
      const nodes = [
        ...(scope?.querySelectorAll?.(
          ".react-select__control,.react-select__placeholder,.react-select__single-value,input",
        ) || []),
      ];
      if (isControl(scope)) nodes.unshift(scope);
      return [...new Set(nodes.filter(isControl))];
    }
    function record(node) {
      if (!states.has(node)) {
        const entry = { revision: 0, writing: false };
        node.addEventListener("input", () => {
          if (!entry.writing) {
            entry.revision++;
            entry.committed = null;
            entry.attempted = null;
            entry.query = undefined;
            entry.options = undefined;
          }
        });
        states.set(node, entry);
      }
      return states.get(node);
    }
    function label(node, info = details(node)) {
      const doc = node.ownerDocument;
      const ids = text(node.getAttribute("aria-labelledby"));
      const direct = text(
        ids
          ? ids
              .split(" ")
              .map((id) => doc.getElementById(id)?.textContent || "")
              .join(" ")
          : node.getAttribute("aria-label") ||
              [...(node.labels || [])]
                .map((item) => item.textContent)
                .join(" "),
      );
      if (direct) return direct;
      if (info?.kind === "rippling-legacy")
        return text(doc.getElementById(node.id + "_label")?.textContent);
      const field = info?.box?.closest(
        'fieldset,.application-field,[data-testid="field"],.field',
      );
      const associated = field?.querySelector(
        "legend,label,.application-label,.ashby-application-form-question-title",
      );
      if (associated) return text(associated.textContent);
      for (
        let parent = info?.box;
        parent && parent !== doc.body;
        parent = parent.parentElement
      ) {
        if (parent.previousElementSibling?.matches("label"))
          return text(parent.previousElementSibling.textContent);
        if (parent.querySelector(":scope > label"))
          return text(parent.querySelector(":scope > label").textContent);
      }
      return "";
    }
    function popup(node, info) {
      const doc = node.ownerDocument,
        linked = doc.getElementById(
          node.getAttribute("aria-controls") || node.getAttribute("aria-owns"),
        );
      if (linked) return linked;
      if (info.kind === "pinpoint") {
        const input = node.querySelector("input"),
          related =
            input &&
            doc.getElementById(
              input.getAttribute("aria-controls") ||
                input.getAttribute("aria-owns"),
            );
        return related || info.box.querySelector(".react-select__menu");
      }
      if (info.kind === "rippling-search" || info.kind === "rippling-location")
        return info.box.querySelector("ul");
      if (info.kind === "rippling-legacy")
        return info.box.querySelector('.Select-menu-outer [role="listbox"]');
      if (info.kind === "greenhouse-legacy")
        return doc
          .getElementById(node.id + "_search")
          ?.closest('.select2-drop,[role="listbox"]');
      if (info.kind === "greenhouse-location")
        return doc.getElementById("location_autocomplete-items-popup");
      if (info.kind === "lever-location")
        return (
          [
            ...(node.parentElement?.querySelectorAll(".dropdown-results") ||
              []),
          ][0] || null
        );
      if (info.kind === "seek-location")
        return node.nextElementSibling?.matches("ul")
          ? node.nextElementSibling
          : [...node.parentElement.querySelectorAll("ul")][0] || null;
      return info.box.querySelector('[role="listbox"]');
    }
    function choices(root, kind) {
      if (!root) return [];
      if (kind === "pinpoint")
        return [...root.querySelectorAll(".react-select__option")];
      if (
        kind === "rippling-search" ||
        kind === "rippling-location" ||
        kind === "seek-location" ||
        kind === "greenhouse-location"
      )
        return [...root.querySelectorAll("li")];
      if (kind === "greenhouse-legacy")
        return [...root.querySelectorAll("li")].filter(
          (option) => !/no matches found/i.test(option.textContent),
        );
      if (kind === "lever-location")
        return [...root.querySelectorAll(":scope > div")];
      return [...root.querySelectorAll('div[role="option"]')];
    }
    function explicitValue(node, info) {
      const marker =
        info.kind === "pinpoint"
          ? info.box.querySelector(".react-select__single-value")
          : info.kind === "rippling-legacy"
            ? info.box.querySelector(".Select-value-label")
            : info.kind === "greenhouse-legacy"
              ? info.box.querySelector(".select2-chosen")
              : null;
      if (marker) return text(marker.textContent);
      const selected = choices(popup(node, info), info.kind).filter(
        (option) => option.getAttribute("aria-selected") === "true",
      );
      return selected.length === 1 &&
        (!info.input ||
          normal(info.input.value) === normal(selected[0].textContent))
        ? text(selected[0].textContent)
        : "";
    }
    function value(node) {
      const info = details(node);
      if (!info) return "";
      const entry = record(node),
        explicit = explicitValue(node, info);
      if (explicit) return explicit;
      return entry.committed &&
        entry.committed.url === node.ownerDocument.location.href &&
        entry.committed.box === info.box &&
        entry.committed.question === label(node, info) &&
        entry.committed.raw === info.input?.value
        ? entry.committed.label
        : "";
    }
    function cachedOptions(node) {
      const entry = states.get(node),
        info = details(node);
      return entry?.box === info?.box &&
        entry.question === label(node, info) &&
        entry.url === node.ownerDocument.location.href
        ? entry.options
        : undefined;
    }
    function describe(node) {
      const info = details(node);
      if (!info) return null;
      const question = label(node, info),
        evidence = [node, info.input, info.box].filter(Boolean);
      const required =
        evidence.some(
          (item) =>
            item.hasAttribute("required") ||
            item.getAttribute("aria-required") === "true",
        ) || /\*\s*$/.test(question);
      const requiredKnown =
        required ||
        evidence.some(
          (item) => item.getAttribute("aria-required") === "false",
        ) ||
        /\(optional\)\s*$/i.test(question);
      const extras =
        info.kind === "greenhouse-legacy"
          ? [node.ownerDocument.getElementById(node.id + "_search")]
          : [];
      const group = [
        node,
        ...info.box.querySelectorAll('input,button,[role="combobox"]'),
        ...extras,
      ].filter(
        (item, index, all) =>
          item &&
          all.indexOf(item) === index &&
          (item === node || !isControl(item)),
      );
      const entry = record(node),
        chosen = value(node);
      if (chosen) entry.attempted = null;
      const pending =
        !chosen &&
        ((info.input?.value && info.input.value !== entry.query) ||
          (entry.attempted?.url === node.ownerDocument.location.href &&
            entry.attempted?.question === question &&
            entry.attempted?.box === info.box));
      return {
        type: "combobox",
        component: info.kind,
        question,
        value: chosen,
        required,
        requiredKnown,
        readable: true,
        supported: true,
        commitState: pending ? "unconfirmed" : undefined,
        invalid: evidence.some(
          (item) => item.getAttribute("aria-invalid") === "true",
        ),
        disabled: evidence.some(
          (item) =>
            item.disabled || item.getAttribute("aria-disabled") === "true",
        ),
        group,
        options: cachedOptions(node),
      };
    }
    function visible(node) {
      if (
        !node.isConnected ||
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
    function operation(
      node,
      info,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        timeout = 3000,
      } = {},
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      const entry = record(node),
        revision = ++entry.revision,
        doc = node.ownerDocument,
        url = doc.location.href,
        question = label(node, info);
      let expected = info.input?.value,
        committing = false;
      const current = () =>
        entry.revision === revision &&
        JobsPageActions.live(canProceed) &&
        doc.location.href === url &&
        node.isConnected &&
        info.box.isConnected &&
        visible(node) &&
        label(node, info) === question &&
        !node.disabled &&
        node.getAttribute("aria-disabled") !== "true" &&
        info.box.getAttribute("aria-disabled") !== "true" &&
        (committing ||
          entry.writing ||
          !info.input ||
          info.input.value === expected);
      return {
        node,
        info,
        entry,
        doc,
        question,
        url,
        timeout,
        current,
        written() {
          expected = info.input?.value;
          entry.query = expected;
        },
        commit() {
          committing = true;
        },
      };
    }
    async function wait(op, read) {
      const found = await JobsDOMWait.until(
        () => (op.current() ? read() : { cancelled: true }),
        { root: op.doc, timeout: op.timeout },
      );
      return op.current() && !found?.cancelled ? found : null;
    }
    function action(kind, node, run) {
      return JobsDiagnostics?.perform
        ? JobsDiagnostics.perform(kind, () => node, run)
        : run();
    }
    function mouse(node) {
      return action("click", node, () => {
        const view = node.ownerDocument.defaultView;
        for (const type of ["mouseover", "mousedown", "mouseup", "click"])
          JobsPageActions.dispatch(
            node,
            new view.MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              view,
            }),
          );
      });
    }
    function click(node) {
      return (
        node &&
        action("click", node, () => {
          JobsPageActions.click(node);
          return node;
        })
      );
    }
    async function write(
      op,
      node,
      answer,
      { blur = true, ashby = false, minimal = false } = {},
    ) {
      if (!node || !op.current()) return null;
      op.entry.writing = true;
      try {
        const result = await action("text", node, async () => {
          if (ashby) {
            if (node.value && node.value === op.entry.query) {
              if (node.value === answer) return node;
              await JobsControlFields.writeText(node, "", {
                blur: false,
                change: false,
                canProceed: op.current,
              });
            }
            if (
              !node.isConnected ||
              node.disabled ||
              node.readOnly ||
              !text(answer) ||
              text(node.value)
            )
              return null;
            if (!JobsControlFields.writeValue(node, answer)) return null;
            if (node.getAttribute("role") !== "combobox") node.blur();
            return node;
          }
          return JobsControlFields.writeText(node, answer, {
            blur,
            keyboard: !minimal,
            click: !minimal,
            change: !minimal,
            canProceed: op.current,
          });
        });
        op.written();
        return result;
      } finally {
        op.entry.writing = false;
      }
    }
    function key(node, keyName, type) {
      const view = node.ownerDocument.defaultView;
      const options =
        keyName === "ArrowDown"
          ? { key: keyName, code: keyName, keyCode: 40, view, bubbles: true }
          : {
              key: "Enter",
              code: "Enter",
              keyCode: 13,
              charCode: 13,
              which: 13,
              bubbles: true,
              cancelable: true,
            };
      JobsPageActions.dispatch(node, new view.KeyboardEvent(type, options));
    }
    // Each kind opens its list once: a click (Pinpoint), ArrowDown (Rippling's
    // legacy select), or typing the search (the location and Select2 kinds).
    async function observe(op, answer) {
      const { node, info, doc } = op;
      if (!op.current()) return [];
      if (info.kind === "pinpoint") {
        await mouse(
          node.querySelector(
            ".react-select__placeholder,.react-select__single-value",
          ) || node,
        );
        return (
          (await wait(op, () => {
            const options = choices(popup(node, info), info.kind);
            return options.length ? options : null;
          })) || []
        );
      }
      if (info.kind === "rippling-legacy") {
        node.focus();
        key(node, "ArrowDown", "keydown");
        return choices(await wait(op, () => popup(node, info)), info.kind);
      }
      if (
        !(await write(op, node, answer, {
          blur: !["lever-location", "seek-location"].includes(info.kind),
          ashby: info.kind === "ashby-location",
          minimal: info.kind === "seek-location",
        }))
      )
        return [];
      if (info.kind === "greenhouse-legacy") {
        const search = await wait(op, () =>
          doc.getElementById(node.id + "_search"),
        );
        if (!search || !(await write(op, search, answer))) return [];
        op.search = search;
        return (
          (await wait(op, () => {
            const found = choices(popup(node, info), info.kind);
            return found.length ? found : null;
          })) || []
        );
      }
      if (info.kind === "lever-location") {
        // Lever renders its results inside an existing wrapper.
        const root = xpath(
          doc,
          `//input[@name='location']/following-sibling::div/div[contains(@class, 'dropdown-results')]`,
        );
        if (!root) return [];
        await wait(op, () => root.childElementCount > 0);
        return choices(root, info.kind);
      }
      if (info.kind === "ashby-location")
        return (
          (await wait(op, () => {
            const found = choices(popup(node, info), info.kind);
            return found.length ? found : null;
          })) || []
        );
      const root = await wait(op, () => popup(node, info));
      if (
        info.kind === "rippling-location" ||
        info.kind === "seek-location" ||
        info.kind === "greenhouse-location"
      )
        return (
          (await wait(op, () => {
            const found = choices(popup(node, info), info.kind);
            return found.length ? found : null;
          })) || []
        );
      return choices(root, info.kind);
    }
    const enabled = (option) =>
      !option.closest('[aria-disabled="true"],[disabled]');
    async function select(op, option) {
      if (!op.current() || !option?.isConnected) return null;
      const { info, node } = op,
        chosen = text(option.textContent);
      const beforePopup = popup(node, info),
        wasVisible = !!beforePopup && visible(beforePopup),
        wasExpanded = node.getAttribute("aria-expanded") === "true";
      op.commit();
      op.entry.writing = true;
      try {
        if (
          [
            "pinpoint",
            "rippling-legacy",
            "greenhouse-legacy",
            "lever-location",
          ].includes(info.kind)
        )
          await mouse(option);
        else click(option);
        if (info.kind === "greenhouse-legacy" && op.search)
          for (const type of ["keydown", "keypress", "keyup"])
            key(op.search, "Enter", type);
      } finally {
        op.entry.writing = false;
      }
      const committed = () => {
        if (
          node.getAttribute("aria-invalid") === "true" ||
          info.box.getAttribute("aria-invalid") === "true"
        )
          return false;
        if (normal(explicitValue(node, info)) === normal(chosen)) return true;
        const root = popup(node, info),
          closed =
            (wasExpanded && node.getAttribute("aria-expanded") === "false") ||
            (wasVisible && (!root || !root.isConnected || !visible(root)));
        return (
          info.input && normal(info.input.value) === normal(chosen) && closed
        );
      };
      op.entry.attempted = {
        box: info.box,
        question: op.question,
        url: op.url,
      };
      if (!(await wait(op, committed))) return null;
      op.entry.attempted = null;
      op.entry.committed = {
        box: info.box,
        question: op.question,
        url: op.url,
        raw: info.input?.value,
        label: chosen,
      };
      return node;
    }
    async function run(
      node,
      answer,
      {
        info = details(node),
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
        timeout = 3000,
        readOnly = false,
        pick,
      } = /** @type {{info?: ReturnType<typeof details>, canProceed?: () => boolean, replace?: boolean, timeout?: number, readOnly?: boolean, pick?: (labels: string[]) => string | null}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (!node || !info || typeof answer !== "string") return null;
      const op = operation(node, info, { canProceed, timeout });
      if (!op.current()) return null;
      if (describe(node)?.commitState === "unconfirmed" && !replace)
        return null;
      if (value(node) && !readOnly) {
        if (
          pick
            ? pick([value(node)]) === value(node)
            : normal(value(node)) === normal(answer)
        )
          return node;
        if (!replace) return null;
      }
      const options = await observe(op, answer);
      if (!op.current()) return null;
      const available = options.filter(
          (option) => enabled(option) && visible(option),
        ),
        labels = available.map((option) => text(option.textContent));
      const unambiguous =
        labels.every(Boolean) &&
        new Set(labels.map(normal)).size === labels.length;
      Object.assign(op.entry, {
        options: unambiguous
          ? labels.map((label) => ({ value: label, label }))
          : [],
        box: info.box,
        question: op.question,
        url: op.url,
      });
      if (readOnly) return op.entry.options;
      const chosen = pick ? pick(labels) : answer;
      const matches = available.filter(
        (option) => normal(option.textContent) === normal(chosen),
      );
      return matches.length === 1 ? select(op, matches[0]) : null;
    }

    async function chooseOptions(node, pick, { query = "", ...options } = {}) {
      return run(node, query, { ...options, pick });
    }
    async function readOptions(
      node,
      canProceed = /** @type {() => boolean} */ (() => true),
      context = {},
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      const info = details(node);
      if (!info) return [];
      if (value(node)) return cachedOptions(node) || [];
      const query = context.answer || "";
      if (
        !["pinpoint", "rippling-legacy", "rippling-search"].includes(
          info.kind,
        ) &&
        !query
      )
        return [];
      return (
        (await run(node, query, {
          readOnly: true,
          canProceed,
          timeout: context.timeout ?? 3000,
        })) || []
      );
    }
    // Every entrance (a binding, a known answer, AI, remote review)
    // ends here: record what was asked and what the control holds afterwards.

    // The only public component transaction. Selection belongs to the caller;
    // this component exposes page facts, commits the selection and reads it back.
    async function chooseFrom(node, pick, options = {}) {
      return chooseOptions(node, pick, options);
    }
    JobsLegacySelectControls = Object.freeze({
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
