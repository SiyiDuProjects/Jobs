import { JobsPageActions } from "./page-actions.js";
import { JobsDOMWait } from "./dom-wait.js";
import { JobsControlFields } from "./control-fields.js";

export var JobsATSChoiceControls;
let initialized = false;
export function initializeAtsChoiceControls() {
  if (initialized) return;
  initialized = true;
  // Paylocity, Eightfold and TikTok choice controls. Every writer enters the
  // same operations below and chooses the unique option equal to its answer.
  (() => {
    const records = new WeakMap(),
      known = new Set();
    const text = (value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const normal = (value) => text(value).normalize("NFKC").toLowerCase();
    const monthNames = [
      "january",
      "february",
      "march",
      "april",
      "may",
      "june",
      "july",
      "august",
      "september",
      "october",
      "november",
      "december",
    ];
    const emptyLabel = (value) =>
      !text(value) ||
      /^(?:select|please select|choose|start date|end date|yyyy[-/]mm|mm[-/]yyyy)(?:\s*[.…]*)?$/i.test(
        text(value),
      );
    function visible(node) {
      if (
        !node?.isConnected ||
        node.closest('[hidden],[inert],[aria-hidden="true"]')
      )
        return false;
      for (
        let parent = node;
        parent?.nodeType === 1;
        parent = parent.parentElement
      ) {
        const style = node.ownerDocument.defaultView.getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden")
          return false;
      }
      return true;
    }
    const literal = (value) =>
      !String(value).includes("'")
        ? `'${value}'`
        : !String(value).includes('"')
          ? `"${value}"`
          : "concat(" +
            String(value)
              .split("'")
              .map((part) => `'${part}'`)
              .join(',"\'",') +
            ")";
    function xpath(node) {
      if (node.id) return `//*[@id=${literal(node.id)}]`;
      const parts = [];
      for (let item = node; item?.nodeType === 1; item = item.parentElement) {
        let index = 1;
        for (
          let sibling = item.previousElementSibling;
          sibling;
          sibling = sibling.previousElementSibling
        )
          if (sibling.localName === item.localName) index++;
        parts.unshift(`${item.localName}[${index}]`);
      }
      return "/" + parts.join("/");
    }
    function labelText(node) {
      if (!node) return "";
      const clone = node.cloneNode(true);
      clone
        .querySelectorAll('input,textarea,select,ul,[role="listbox"]')
        .forEach((item) => item.remove());
      return text(clone.textContent);
    }
    function fieldLabel(node) {
      const doc = node.ownerDocument,
        by = text(node.getAttribute("aria-labelledby"));
      if (by) {
        const value = text(
          by
            .split(" ")
            .map((id) => labelText(doc.getElementById(id)))
            .join(" "),
        );
        if (value) return value;
      }
      const explicit = text(
        node.getAttribute("aria-label") ||
          [...(node.labels || [])].map(labelText).join(" "),
      );
      if (explicit) return explicit;
      if (node.id) {
        const labels = [...doc.querySelectorAll("label[for]")].filter(
          (label) => label.htmlFor === node.id,
        );
        if (labels.length === 1) return labelText(labels[0]);
      }
      const own = node.closest("label");
      if (own) return labelText(own);
      for (
        let item = node, depth = 0;
        item && depth < 4;
        item = item.parentElement, depth++
      ) {
        const previous = item.previousElementSibling;
        if (
          previous?.matches(
            'label,legend,[class*="body-question-label"],[class*="apply-question-label-container"],.form-label,.formLabel',
          )
        )
          return labelText(previous);
        const direct = item.parentElement?.querySelector(
          ":scope > label,:scope > legend",
        );
        if (direct) return labelText(direct);
      }
      return "";
    }
    function monthValue(value) {
      const raw = text(value);
      let match = raw.match(/^(\d{4})[-/.](\d{1,2})$/),
        year,
        month;
      if (match) {
        year = +match[1];
        month = +match[2];
      } else if ((match = raw.match(/^(\d{1,2})[-/.](\d{4})$/))) {
        year = +match[2];
        month = +match[1];
      } else if ((match = raw.match(/^([A-Za-z]+)\s+(\d{4})$/))) {
        year = +match[2];
        month =
          monthNames.findIndex(
            (name) =>
              name === match[1].toLowerCase() ||
              name.slice(0, 3) === match[1].toLowerCase(),
          ) + 1;
      }
      return year > 0 && month >= 1 && month <= 12
        ? `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`
        : "";
    }
    function structuralKind(node) {
      if (!node?.matches) return null;
      if (
        node.matches(".atsx-date-picker-period-month-label") &&
        node.closest(".atsx-date-picker")
      )
        return "tiktok-month";
      if (node.matches(".ud__select__selector")) return "tiktok-disclosure";
      if (node.matches(".atsx-select")) return "tiktok-dropdown";
      if (
        node.matches(
          '[data-automation-id^="public-site-address-"][data-automation-id$="-input-base"]',
        ) &&
        node.querySelector("input")
      )
        return "paylocity-search";
      if (
        node.matches("div[id]") &&
        /^(?:info\.|acknowledgements\.|workHistory\.mayWeContactSupervisor\.|educationHistory\.(?:type|didYouGraduate|degreeId)\.)/.test(
          node.id,
        ) &&
        node.querySelector("ul,li")
      )
        return "paylocity-dropdown";
      if (node.matches("input") && node.closest('[class*="select-module"]'))
        return "eightfold-question";
      if (
        node.matches('input[role="combobox"]') &&
        !node.closest('.select,.atsx-select,[class*="select-module"]')
      ) {
        const owner = node.closest("[data-test-id]") || node.parentElement;
        if (
          owner?.querySelector('ul[role="listbox"] li button[role="option"]') ||
          (/\.eightfold\.ai$/.test(node.ownerDocument.location.hostname) &&
            node.closest("[data-test-id]"))
        )
          return "eightfold-combobox";
      }
      if (
        node.matches('div[class*="checkBoxGroup"],div[role="radiogroup"]') &&
        node.querySelector('input[type="radio"],input[type="checkbox"]') &&
        (node.matches('[class*="checkBoxGroup"]') ||
          node.parentElement?.previousElementSibling?.matches(
            '[class*="body-question-label"],[class*="apply-question-label-container"]',
          ))
      )
        return "eightfold-choice";
      return null;
    }
    const kindOf = (node) => records.get(node)?.kind || structuralKind(node);
    const isControl = (node) => !!kindOf(node);
    function register(node, kind) {
      if (!node) return null;
      let entry = records.get(node);
      if (!entry) {
        entry = { kind, revision: 0 };
        records.set(node, entry);
        known.add(node);
        node.addEventListener("input", () => {
          if (!entry.writing) {
            entry.committed = null;
            entry.unconfirmed = null;
            entry.options = undefined;
            entry.revision++;
          }
        });
      }
      entry.kind = kind;
      return entry;
    }
    function find(scope) {
      const nodes = [
        scope,
        ...scope.querySelectorAll(
          '.atsx-date-picker-period-month-label,.ud__select__selector,.atsx-select,[data-automation-id$="-input-base"],div[id],input[role="combobox"],[class*="select-module"] input,div[class*="checkBoxGroup"],div[role="radiogroup"]',
        ),
      ];
      for (const node of known) {
        if (!node.isConnected) known.delete(node);
        else if (node === scope || scope.contains(node)) nodes.push(node);
      }
      return [...new Set(nodes.filter(isControl))].filter(
        (node) =>
          !nodes.some(
            (other) =>
              other !== node &&
              kindOf(other) === kindOf(node) &&
              other.contains?.(node) &&
              records.has(other),
          ),
      );
    }
    function searchInput(node) {
      return node.matches("input")
        ? node
        : node.querySelector(
            'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"])',
          );
    }
    function explicitDisplay(node) {
      const own = text(
        node.getAttribute("aria-valuetext") ||
          node.getAttribute("data-selected-value"),
      );
      if (own && !emptyLabel(own)) return own;
      const selected = node.querySelector(
        ".atsx-select-selection-item,.atsx-select-selection-selected-value,.ud__select__selection-item,.ud__select__selector-text,.selected-value,.single-value",
      );
      if (selected && !emptyLabel(selected.textContent))
        return text(selected.textContent);
      const select = node.querySelector("select");
      if (select?.value && !["-1", "-999"].includes(select.value))
        return text(select.selectedOptions[0]?.textContent);
      const input = searchInput(node);
      return input?.readOnly && !emptyLabel(input.value)
        ? text(input.value)
        : "";
    }
    function choiceItems(node) {
      return [
        ...node.querySelectorAll('input[type="radio"],input[type="checkbox"]'),
      ].map((input) => ({
        input,
        label:
          fieldLabel(input) ||
          text(
            input.nextElementSibling?.matches("label")
              ? input.nextElementSibling.textContent
              : "",
          ),
      }));
    }
    function multiple(node) {
      return (
        kindOf(node) === "eightfold-choice" &&
        choiceItems(node).every(({ input }) => input.type === "checkbox") &&
        !/\b(?:check|choose|select) (?:only |exactly )?one\b/i.test(
          fieldLabel(node),
        )
      );
    }
    function value(node) {
      const kind = kindOf(node);
      if (!kind) return "";
      if (kind === "tiktok-month")
        return monthValue(
          node.getAttribute("data-value") ||
            node.getAttribute("aria-valuetext") ||
            node.textContent,
        );
      if (kind === "eightfold-choice") {
        const selected = choiceItems(node)
          .filter(({ input }) => input.checked)
          .map(({ label }) => label);
        return multiple(node)
          ? selected
          : selected.length === 1
            ? selected[0]
            : "";
      }
      const display = explicitDisplay(node);
      if (display) return display;
      const entry = records.get(node),
        committed = entry?.committed,
        input = searchInput(node);
      return committed &&
        committed.url === node.ownerDocument.location.href &&
        committed.question === fieldLabel(node) &&
        committed.raw === (input?.value ?? null)
        ? committed.label
        : "";
    }
    function disabled(node) {
      return (
        node.disabled === true ||
        node.getAttribute("aria-disabled") === "true" ||
        !!node.closest('[inert],[aria-disabled="true"]') ||
        node.matches(":disabled")
      );
    }
    function requiredness(node, label, group) {
      const nodes = [node, ...group];
      if (
        nodes.some(
          (item) =>
            item.required || item.getAttribute("aria-required") === "true",
        ) ||
        /\*\s*$/.test(label)
      )
        return { required: true, requiredKnown: true };
      if (
        nodes.some((item) => item.getAttribute("aria-required") === "false") ||
        /\boptional\b/i.test(label)
      )
        return { required: false, requiredKnown: true };
      return { required: false, requiredKnown: false };
    }
    function cachedOptions(node) {
      const entry = records.get(node);
      return entry?.question === fieldLabel(node) &&
        entry.url === node.ownerDocument.location.href
        ? entry.options
        : undefined;
    }
    function describe(node) {
      const kind = kindOf(node);
      if (!kind) return null;
      const group = [
        node,
        ...node.querySelectorAll(
          'input,select,textarea,[role="combobox"],[role="radio"],[role="checkbox"]',
        ),
      ].filter((item) => item === node || !isControl(item));
      let label = fieldLabel(node);
      if (
        kind === "tiktok-month" &&
        !node.hasAttribute("aria-label") &&
        !node.hasAttribute("aria-labelledby")
      ) {
        const siblings = [
          ...node
            .closest(".atsx-date-picker")
            .querySelectorAll(".atsx-date-picker-period-month-label"),
        ];
        label = label
          ? `${label} — ${siblings.indexOf(node) === 0 ? "Start month" : "End month"}`
          : siblings.indexOf(node) === 0
            ? "Start month"
            : "End month";
      }
      const choices = kind === "eightfold-choice" ? choiceItems(node) : null,
        entry = records.get(node);
      const raw = value(node),
        unknownMonth =
          kind === "tiktok-month" && !raw && !emptyLabel(node.textContent);
      if (
        entry?.unconfirmed &&
        (entry.unconfirmed.url !== node.ownerDocument.location.href ||
          entry.unconfirmed.question !== fieldLabel(node) ||
          (Array.isArray(raw)
            ? raw.some(
                (value) => normal(value) === normal(entry.unconfirmed.answer),
              )
            : normal(raw) === normal(entry.unconfirmed.answer)))
      )
        entry.unconfirmed = null;
      const options =
        choices?.map(({ label }) => ({ value: label, label })) ||
        cachedOptions(node);
      return {
        component: kind,
        type:
          kind === "tiktok-month"
            ? "month"
            : choices
              ? multiple(node)
                ? "select-multiple"
                : "custom-radio"
              : "combobox",
        question: label,
        value: unknownMonth ? text(node.textContent) : raw,
        group,
        ...requiredness(node, label, group),
        disabled: disabled(node),
        invalid: group.some(
          (item) =>
            item.getAttribute("aria-invalid") === "true" ||
            (item.willValidate && !item.validity.valid),
        ),
        readable: !unknownMonth,
        supported:
          !disabled(node) &&
          !!label &&
          (!choices || choices.every((item) => item.label)),
        options,
        ...(entry?.unconfirmed ? { commitState: "unconfirmed" } : {}),
      };
    }
    function mouse(node) {
      const view = node.ownerDocument.defaultView;
      for (const type of ["mouseover", "mousedown", "mouseup", "click"])
        JobsPageActions.dispatch(
          node,
          new view.MouseEvent(type, { bubbles: true, cancelable: true, view }),
        );
    }
    function mutate(node, action) {
      const entry = records.get(node);
      if (!entry) return action();
      const previous = entry.writing;
      entry.writing = true;
      try {
        return action();
      } finally {
        entry.writing = previous;
      }
    }
    function strictHelpers(node, current, timeout) {
      const doc = node.ownerDocument;
      const all = (query, root = doc) => {
        const result = doc.evaluate(
          query,
          root,
          null,
          doc.defaultView.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null,
        );
        return Array.from({ length: result.snapshotLength }, (_, index) =>
          result.snapshotItem(index),
        );
      };
      const find = (query, root) => all(query, root)[0] || null;
      const wait = async (read) => {
        const found = await JobsDOMWait.until(
          () => (current() ? read() : { cancelled: true }),
          { root: doc, timeout },
        );
        return current() && !found?.cancelled ? found : [];
      };
      return {
        find,
        all,
        click: (query, useXPath = false) => {
          if (!current()) return null;
          const targets = useXPath
              ? all(query)
              : [...doc.querySelectorAll(query)],
            valid = targets.filter((item) => visible(item) && !disabled(item));
          if (valid.length !== 1) return null;
          mutate(node, () => JobsPageActions.click(valid[0]));
          return valid[0];
        },
        write: async (answer, query) => {
          const input = find(query),
            entry = records.get(node);
          if (!input) return null;
          entry.writing = true;
          try {
            return await JobsControlFields.writeText(input, answer, {
              canProceed: current,
            });
          } finally {
            entry.writing = false;
          }
        },
        dispatch: (item) => {
          if (current() && visible(item) && !disabled(item))
            mutate(node, () => mouse(item));
        },
        waitCss: (selector) =>
          wait(() => {
            const nodes = [...doc.querySelectorAll(selector)].filter(visible);
            return nodes.length ? nodes : null;
          }),
        waitXPath: (query) =>
          wait(() => {
            const nodes = all(query).filter(visible);
            return nodes.length ? nodes : null;
          }),
        retry: async (query, delay, attempts, onRetry) => {
          for (let index = 1; index <= attempts && current(); index++) {
            const nodes = await JobsDOMWait.until(
              () => {
                const found = all(query).filter(visible);
                return current() && found.length ? found : null;
              },
              { root: doc, timeout: Math.min(delay, timeout) },
            );
            if (!current()) return [];
            if (nodes) return nodes;
            if (index < attempts) onRetry?.();
          }
          return [];
        },
      };
    }
    function strictArgs(node, answer) {
      const kind = kindOf(node);
      if (kind === "paylocity-dropdown") return [answer, xpath(node), true];
      if (kind === "paylocity-search")
        return [
          answer,
          xpath(node),
          "#" +
            node
              .getAttribute("data-automation-id")
              .replace(/-input-base$/, "-dropdown-list-container"),
        ];
      if (kind === "eightfold-question") {
        const wrapper = node.closest('[class*="select-module"]');
        let parent = wrapper;
        while (
          parent?.parentElement &&
          !parent.previousElementSibling?.matches(
            '[class*="body-question-label"],[class*="apply-question-label-container"],label',
          )
        )
          parent = parent.parentElement;
        return parent?.previousElementSibling
          ? [answer, xpath(parent.previousElementSibling), true]
          : null;
      }
      if (kind === "eightfold-combobox")
        return [
          answer,
          xpath(node.closest("[data-test-id]") || node.parentElement),
          true,
        ];
      if (kind === "eightfold-choice") return [answer, null, true];
      return [xpath(node), answer, true];
    }
    const optionLabel = (node) =>
      text(node.textContent) || text(node.getAttribute("data-cy-value"));
    function virtualComplete(nodes) {
      if (!nodes.length) return false;
      const total = Number(nodes[0].getAttribute("aria-setsize"));
      const positions = nodes.map((node) =>
        Number(node.getAttribute("aria-posinset")),
      );
      return (
        Number.isInteger(total) &&
        total > 0 &&
        nodes.length === total &&
        new Set(positions).size === total &&
        positions.every((position) => position >= 1 && position <= total)
      );
    }
    // Each kind's open/search/choose recipe. A choice is the unique visible,
    // enabled option whose label the caller's rule picks (context.pickLabel).
    async function operate(kind, args, h, context) {
      const { intent, current } = context;
      if (!args) return null;
      let node = context.node;
      const remember = (trigger) => {
        node = trigger;
        if (trigger) register(trigger, kind);
        context.node = trigger;
        return trigger;
      };
      const optionsResult = (nodes) => {
        context.options = nodes;
        return null;
      };
      const allowed = (nodes) =>
        [...nodes].filter((option) => visible(option) && !disabled(option));
      const pick = (nodes) => {
        const candidates = allowed(nodes),
          labels = candidates.map(optionLabel);
        context.seen = labels;
        const label = labels.length ? context.pickLabel(labels) : null,
          matches = label
            ? candidates.filter((option) => optionLabel(option) === label)
            : [];
        return matches.length === 1 ? matches[0] : null;
      };
      const chooseOption = (
        option,
        click = (element) => JobsPageActions.click(element),
      ) => {
        if (!option || !current()) return null;
        context.option = option;
        context.before = searchInput(node)?.value;
        context.expanded = node.getAttribute("aria-expanded");
        mutate(node, () => click(option));
        return option;
      };
      if (kind === "paylocity-dropdown") {
        const [answer, selector, useXPath] = args;
        const trigger = remember(
          JobsPageActions.when(() => h.click(selector, useXPath)),
        );
        if (!trigger) return;
        const nodes = trigger.querySelectorAll("li");
        if (intent === "options") return optionsResult(allowed(nodes));
        return chooseOption(pick(nodes));
      }
      if (kind === "paylocity-search") {
        const [answer, containerXPath, listSelector] = args;
        const container = h.find(containerXPath);
        if (container === null) return null;
        remember(container);
        if (intent !== "options" || answer)
          await h.write(answer, `${containerXPath}//input`, true);
        if (!current()) return null;
        h.dispatch(h.find(`${containerXPath}//input`));
        const lists = await h.waitCss(listSelector);
        if (!current() || !lists[0]) return null;
        const nodes = lists[0].querySelectorAll(".ListItemEven,.ListItemOdd");
        if (intent === "options") return optionsResult(allowed(nodes));
        return chooseOption(pick(nodes), h.dispatch);
      }
      if (kind === "eightfold-question") {
        const [answer, labelXPath] = args;
        const trigger = remember(
          JobsPageActions.when(() =>
            h.click(
              `${labelXPath}/following-sibling::div//div[contains(@class, 'select-module')]//input`,
              true,
            ),
          ),
        );
        if (!trigger) return;
        const nodes = await h.retry(
          `${labelXPath}/following-sibling::div//ul/li/button`,
          300,
          3,
          () =>
            JobsPageActions.when(() =>
              h.click(
                `${labelXPath}/following-sibling::div//div[contains(@class, 'select-module')]//input`,
                true,
              ),
            ),
        );
        if (intent === "options") return optionsResult(allowed(nodes));
        return chooseOption(pick(nodes));
      }
      if (kind === "eightfold-combobox") {
        const [answer, containerXPath] = args,
          query = `${containerXPath}//input[@role='combobox']`,
          input = remember(h.find(query));
        if (!input) return null;
        if (!current()) return null;
        mutate(node, () => JobsPageActions.click(input));
        const nodes = await h.retry(
          `${containerXPath}//ul[@role='listbox']/li/button[@role='option']`,
          300,
          3,
          () => JobsPageActions.when(() => h.click(query, true)),
        );
        if (intent === "options") return optionsResult(allowed(nodes));
        return chooseOption(pick(nodes));
      }
      if (kind === "eightfold-choice") {
        const [answer] = args;
        const nodes = choiceItems(node)
          .map((item) => item.input.nextElementSibling)
          .filter((item) => item?.matches("label"));
        if (intent === "options") return optionsResult(nodes);
        const labels = nodes.filter((label) => {
          const input = h.find("preceding-sibling::input", label);
          return input && !disabled(input);
        });
        const selected = pick(labels);
        if (selected) {
          const input = h.find("preceding-sibling::input", selected);
          if (input && current()) {
            context.option = selected;
            context.choiceInput = input;
            mutate(node, () => mouse(input));
            return selected;
          }
        }
        return null;
      }
      if (kind === "tiktok-month") {
        const [pickerXPath, month] = args,
          [year, part] = month.split("-");
        const popup = `//div[contains(@class, 'atsx-date-picker-dropdown') and not(contains(@class, 'atsx-date-picker-dropdown-hidden'))]`;
        const trigger = remember(
          JobsPageActions.when(() => h.click(pickerXPath, true)),
        );
        if (trigger) {
          await h.waitXPath(popup);
          if (current()) {
            JobsPageActions.when(() =>
              h.click(
                `${popup}//div[contains(@class, 'scrollbar-container')][1]//div[@data-cy='${year}']`,
                true,
              ),
            );
            context.option = JobsPageActions.when(() =>
              h.click(
                `${popup}//div[contains(@class, 'scrollbar-container')][2]//div[@data-cy='${part}']`,
                true,
              ),
            );
          }
        }
        return;
      }
      if (kind === "tiktok-dropdown") {
        const [triggerXPath, answer] = args,
          popup = `//div[contains(@class, 'atsx-select-dropdown') and not(contains(@class, 'atsx-select-dropdown-hidden'))]//ul`;
        if (remember(JobsPageActions.when(() => h.click(triggerXPath, true)))) {
          const lists = await h.waitXPath(popup);
          if (!current()) return;
          if (lists.length !== 1) return null;
          const nodes = allowed(
            lists[0].querySelectorAll("li span[data-cy-value]"),
          );
          if (intent === "options") return optionsResult(nodes);
          return chooseOption(pick(nodes));
        }
        return;
      }
      if (kind === "tiktok-disclosure") {
        const [triggerXPath, answer] = args,
          popup = `${triggerXPath}/following-sibling::div//div[contains(@class, 'ud__select__dropdown') and not(contains(@class, 'ud__select__dropdown-hidden'))]//div[contains(@class, 'rc-virtual-list-holder-inner')]`;
        if (remember(JobsPageActions.when(() => h.click(triggerXPath, true)))) {
          const lists = await h.waitXPath(popup);
          if (!current()) return;
          if (lists.length !== 1) return null;
          const nodes = allowed(
            lists[0].querySelectorAll(".ud__select__list__item"),
          );
          if (!virtualComplete(nodes)) {
            context.partial = true;
            return null;
          }
          if (intent === "options") return optionsResult(nodes);
          const result = chooseOption(pick(nodes));
          if (result) JobsPageActions.when(() => h.click("main"));
          return result;
        }
        return;
      }
      return null;
    }
    function lifecycle(node, canProceed) {
      canProceed = JobsPageActions.guard(canProceed);
      const entry = register(node, kindOf(node)),
        revision = ++entry.revision,
        url = node.ownerDocument.location.href,
        label = fieldLabel(node);
      return {
        entry,
        current: () =>
          JobsPageActions.live(canProceed) &&
          entry.revision === revision &&
          visible(node) &&
          !disabled(node) &&
          node.ownerDocument.location.href === url &&
          fieldLabel(node) === label,
        url,
        label,
      };
    }
    async function readOptions(
      node,
      canProceed = /** @type {() => boolean} */ (() => true),
      context = {},
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (!isControl(node) || kindOf(node) === "tiktok-month") return [];
      if (kindOf(node) === "eightfold-choice") return describe(node).options;
      const op = lifecycle(node, canProceed),
        query = context.answer;
      const before = searchInput(node)?.value,
        expanded = node.getAttribute("aria-expanded");
      const run = {
        node,
        intent: "options",
        current: op.current,
        pickLabel: () => null,
      };
      await operate(
        kindOf(node),
        strictArgs(node, query),
        strictHelpers(node, op.current, context.timeout ?? 1200),
        run,
      );
      const labels = (run.options || []).map(optionLabel);
      const options =
        op.current() &&
        !run.partial &&
        labels.length &&
        labels.length <= 1000 &&
        new Set(labels.map(normal)).size === labels.length
          ? labels.map((label) => ({ value: label, label }))
          : [];
      // Close only a popup opened here; restoration is explicit and cannot select.
      if (
        op.current() &&
        expanded !== "true" &&
        node.getAttribute("aria-expanded") === "true"
      )
        JobsPageActions.dispatch(
          node,
          new node.ownerDocument.defaultView.KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      if (
        op.current() &&
        query &&
        searchInput(node)?.value === String(query) &&
        before !== query
      ) {
        op.entry.writing = true;
        try {
          await JobsControlFields.writeText(searchInput(node), before ?? "", {
            canProceed: op.current,
          });
        } finally {
          op.entry.writing = false;
        }
      }
      if (op.current())
        Object.assign(op.entry, {
          options,
          question: op.label,
          url: op.url,
          partial: !!run.partial,
        });
      return options;
    }
    // One transaction: open or search once (a search types its term), let the
    // caller's rule pick one label among the listed options, choose that option
    // in the same list and verify the page committed it.
    async function transaction(
      node,
      pickLabel,
      {
        query,
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
        timeout = 1200,
      } = /** @type {{query?: string, canProceed?: () => boolean, replace?: boolean, timeout?: number}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (
        !isControl(node) ||
        !JobsPageActions.live(canProceed) ||
        !visible(node) ||
        disabled(node) ||
        typeof pickLabel !== "function"
      )
        return null;
      if (
        kindOf(node) === "tiktok-month" ||
        (describe(node)?.commitState === "unconfirmed" && !replace) ||
        (value(node) && !replace)
      )
        return null;
      const op = lifecycle(node, canProceed);
      if (!op.current()) return null;
      const run = { node, intent: "choose", current: op.current, pickLabel };
      await operate(
        kindOf(node),
        strictArgs(node, query ?? ""),
        strictHelpers(node, op.current, timeout),
        run,
      );
      if (
        run.seen?.length &&
        new Set(run.seen.map(normal)).size === run.seen.length
      )
        op.entry.options = run.seen.map((label) => ({ value: label, label }));
      if (!op.current() || run.partial || !run.option) return null;
      const label = optionLabel(run.option);
      const accepted = () => {
        if (!op.current()) return false;
        if (run.choiceInput) return run.choiceInput.checked;
        if (normal(explicitDisplay(node)) === normal(label)) return true;
        const input = searchInput(node);
        return (
          normal(input?.value) === normal(label) &&
          (input.value !== run.before ||
            run.option.getAttribute("aria-selected") === "true" ||
            (run.expanded === "true" &&
              node.getAttribute("aria-expanded") === "false"))
        );
      };
      if (
        !(await JobsDOMWait.until(accepted, {
          root: node.ownerDocument,
          timeout,
        }))
      )
        return null;
      op.entry.unconfirmed = null;
      op.entry.committed = {
        label,
        raw: searchInput(node)?.value ?? null,
        url: op.url,
        question: op.label,
      };
      return node;
    }
    const chooseOptions = (
      node,
      pickLabel,
      {
        query,
        canProceed,
        replace = false,
      } = /** @type {{query?: string, canProceed?: () => boolean, replace?: boolean}} */ ({}),
    ) => transaction(node, pickLabel, { query, canProceed, replace });
    // An exact answer: a month picker takes its YYYY-MM value; a list its one equal label.
    async function chooseUntraced(
      node,
      answer,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
        timeout = 1200,
      } = /** @type {{canProceed?: () => boolean, replace?: boolean, timeout?: number}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (
        !isControl(node) ||
        !JobsPageActions.live(canProceed) ||
        !visible(node) ||
        disabled(node) ||
        typeof answer !== "string" ||
        !answer.trim()
      )
        return null;
      if (describe(node)?.commitState === "unconfirmed" && !replace)
        return null;
      const old = value(node);
      if (old) {
        if (normal(old) === normal(answer)) return node;
        if (!replace) return null;
      }
      if (kindOf(node) !== "tiktok-month")
        return transaction(
          node,
          (labels) => {
            const same = labels.filter(
              (label) => normal(label) === normal(answer),
            );
            return same.length === 1 ? same[0] : null;
          },
          { query: answer, canProceed, replace: true, timeout },
        );
      if (monthValue(answer) !== answer) return null;
      const op = lifecycle(node, canProceed);
      if (!op.current()) return null;
      const run = { node, intent: "choose", current: op.current };
      await operate(
        kindOf(node),
        strictArgs(node, answer),
        strictHelpers(node, op.current, timeout),
        run,
      );
      if (
        !op.current() ||
        !(await JobsDOMWait.until(
          () => op.current() && value(node) === answer,
          { root: node.ownerDocument, timeout },
        ))
      )
        return null;
      op.entry.unconfirmed = null;
      op.entry.committed = {
        label: answer,
        raw: null,
        url: op.url,
        question: op.label,
      };
      return node;
    }
    async function chooseMultipleUntraced(
      node,
      answers,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
        timeout = 1200,
      } = /** @type {{canProceed?: () => boolean, replace?: boolean, timeout?: number}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (
        !multiple(node) ||
        !Array.isArray(answers) ||
        new Set(answers.map(normal)).size !== answers.length
      )
        return null;
      const items = choiceItems(node),
        desired = new Set(answers.map(normal));
      if (
        answers.some(
          (answer) =>
            items.filter((item) => normal(item.label) === normal(answer))
              .length !== 1,
        )
      )
        return null;
      if (!replace && items.some((item) => item.input.checked))
        return normal(value(node).join(";")) === normal(answers.join(";"))
          ? node
          : null;
      const op = lifecycle(node, canProceed);
      for (const item of items) {
        if (
          !op.current() ||
          (disabled(item.input) &&
            item.input.checked !== desired.has(normal(item.label)))
        )
          return null;
        if (item.input.checked !== desired.has(normal(item.label)))
          mutate(node, () => mouse(item.input));
      }
      return (await JobsDOMWait.until(
        () =>
          op.current() &&
          items.every(
            (item) => item.input.checked === desired.has(normal(item.label)),
          ),
        { root: node.ownerDocument, timeout },
      ))
        ? node
        : null;
    }
    // Every entrance (a binding, a known answer, AI, remote review)
    // ends here: record what was asked and what the control holds afterwards.

    // The only public component transaction. Selection belongs to the caller;
    // this component exposes page facts, commits the selection and reads it back.
    async function chooseFrom(node, pick, options = {}) {
      if (kindOf(node) === "tiktok-month")
        return chooseUntraced(node, pick([]), options);
      if (multiple(node)) {
        const selected = pick(choiceItems(node).map((item) => item.label));
        return selected == null
          ? null
          : chooseMultipleUntraced(node, [selected].flat(), options);
      }
      return chooseOptions(node, pick, options);
    }
    JobsATSChoiceControls = {
      find,
      isControl,
      describe,
      value,
      cachedOptions,
      readOptions,
      chooseFrom,
      multiple,
      monthValue,
    };
  })();
}
