import { JobsControlFields } from "./control-fields.js";
import { JobsPageActions } from "./page-actions.js";
import { JobsDOMWait } from "./dom-wait.js";

export var JobsShadowControls;
let initialized = false;
export function initializeShadowControls() {
  if (initialized) return;
  initialized = true;
  // The known SPL and UI5 widgets expose open shadow roots. Keep their original
  // event recipes, while reading and supplementing through the same component.
  (() => {
    const text = (value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const norm = (value) => text(value).normalize("NFKC").toLowerCase();
    const selector =
      'spl-autocomplete,spl-multiselect-autocomplete,spl-radio-group,spl-dropzone,spl-date-field,spl-phone-field,spl-input,spl-textarea,spl-checkbox,ui5-date-picker-xweb-calendar-widget,[data-test="resume-upload"]';
    const attempts = new WeakMap(),
      optionsCache = new WeakMap(),
      searchWrites = new WeakMap();
    const parent = (node) => node?.parentElement || node?.getRootNode?.().host;
    function visible(node) {
      if (!node?.isConnected) return false;
      for (let item = node; item?.nodeType === 1; item = parent(item)) {
        if (item.matches('[hidden],[inert],[aria-hidden="true"]')) return false;
        const style = node.ownerDocument.defaultView.getComputedStyle(item);
        if (style.display === "none" || style.visibility === "hidden")
          return false;
      }
      return true;
    }
    function kind(node) {
      if (node?.matches?.("spl-multiselect-autocomplete"))
        return "autocomplete-multiple";
      if (node?.matches?.("spl-radio-group")) return "radio";
      if (node?.matches?.("spl-dropzone")) return "file";
      return node?.matches?.("spl-autocomplete")
        ? "autocomplete"
        : node?.matches?.("spl-date-field")
          ? "date"
          : node?.matches?.("ui5-date-picker-xweb-calendar-widget")
            ? "ui5-date"
            : node?.matches?.("spl-phone-field")
              ? "phone"
              : node?.matches?.("spl-checkbox")
                ? "checkbox"
                : node?.matches?.('[data-test="resume-upload"]')
                  ? "file"
                  : node?.matches?.("spl-input,spl-textarea")
                    ? "text"
                    : null;
    }
    function parts(node) {
      const type = kind(node),
        shadow = node?.shadowRoot;
      if (!type) return null;
      let inner, input;
      if (type === "autocomplete")
        inner = shadow?.querySelector("spl-internal-form-field spl-input");
      else if (type === "date")
        inner = shadow?.querySelector(
          "spl-internal-form-field spl-date-picker",
        );
      else if (type === "ui5-date")
        inner = shadow?.querySelector("ui5-input-xweb-calendar-widget");
      else if (type === "phone") inner = shadow?.querySelector("spl-input");
      input = (inner ? inner.shadowRoot : shadow)?.querySelector(
        type === "file" ? 'input[type="file"]' : "input,textarea",
      );
      if (type === "radio") input = node;
      return { node, type, shadow, inner, input };
    }
    const isControl = (node) => !!kind(node);
    function find(scope = document) {
      return [scope, ...scope.querySelectorAll(selector)].filter(
        (node) => isControl(node) && visible(node),
      );
    }
    function label(control) {
      const { node, input } = control;
      const refs = text(
        node.getAttribute("aria-labelledby") ||
          input?.getAttribute("aria-labelledby"),
      )
        .split(" ")
        .filter(Boolean);
      return text(
        refs
          .map(
            (id) =>
              node.getRootNode().getElementById?.(id)?.textContent ||
              node.ownerDocument.getElementById(id)?.textContent ||
              "",
          )
          .join(" ") ||
          node.getAttribute("label") ||
          [...node.children].find(
            (child) => child.getAttribute("slot") === "label-content",
          )?.textContent ||
          node.getAttribute("aria-label") ||
          input?.getAttribute("aria-label") ||
          control.shadow?.querySelector('label,[slot="label"]')?.textContent ||
          node.closest("[data-test]")?.querySelector(":scope > label")
            ?.textContent ||
          node.closest(".fieldComponentInput")?.previousElementSibling
            ?.textContent ||
          "",
      );
    }
    const optionLabel = (option) =>
      text(
        option.getAttribute("label") ||
          option.querySelector(
            "spl-typography-body:not(.c-spl-autocomplete-option-description)",
          )?.textContent ||
          option.textContent,
      );
    const radioOptions = (node) =>
      [...node.querySelectorAll("spl-radio")]
        .filter(
          (option) =>
            visible(option) &&
            !option.hasAttribute("disabled") &&
            option.getAttribute("aria-disabled") !== "true",
        )
        .map((option) => text(option.getAttribute("label")));
    const hasValue = (raw) => (Array.isArray(raw) ? raw.length > 0 : !!raw);
    const monthMode = (p) =>
      p.type === "date" && p.node.getAttribute("type") === "month-year";
    function dateValue(p, raw) {
      if (!monthMode(p))
        return JobsControlFields.calendarDate(raw)?.iso || null;
      const full = JobsControlFields.calendarDate(raw);
      if (full) return full.iso.slice(0, 7);
      const iso = text(raw).match(/^(\d{4})-(0[1-9]|1[0-2])$/),
        display = text(raw).match(/^(0?[1-9]|1[0-2])\/(\d{4})$/);
      const year = iso?.[1] || display?.[2],
        month = iso?.[2] || display?.[1];
      return year && +year > 0 && month
        ? `${year}-${month.padStart(2, "0")}`
        : null;
    }
    function selected(control) {
      const selected = [
        ...(control.shadow?.querySelectorAll("spl-select-option") || []),
      ].filter(
        (option) =>
          option.getAttribute("aria-selected") === "true" ||
          option.hasAttribute("selected") ||
          !!option.shadowRoot
            ?.querySelector("spl-dropdown-item")
            ?.shadowRoot?.querySelector('[aria-selected="true"]'),
      );
      if (control.type === "autocomplete-multiple") {
        const tags = [
          ...(control.shadow
            ?.querySelector("spl-tags-list")
            ?.shadowRoot?.querySelectorAll("spl-tag") || []),
        ];
        return [
          ...new Set([
            ...selected.map(optionLabel),
            ...tags
              .map((tag) =>
                text(
                  tag.shadowRoot?.querySelector(".c-spl-tag-label")
                    ?.textContent || tag.getAttribute("label"),
                ),
              )
              .filter(Boolean),
          ]),
        ];
      }
      if (selected.length === 1) return optionLabel(selected[0]);
      const search = searchWrites.get(control.node);
      // SPL renders the clear control only for a committed value. Custom
      // options deliberately have no selected marker; search text alone is not proof.
      return (control.input?.readOnly ||
        control.shadow?.querySelector(".c-spl-autocomplete-close")) &&
        !(
          search?.input === control.input &&
          search.value === control.input.value
        )
        ? text(control.input.value)
        : "";
    }
    function value(node) {
      const p = parts(node);
      if (!p?.input) return "";
      if (p.type.startsWith("autocomplete")) return selected(p);
      if (p.type === "radio")
        return text(
          node
            .querySelector('spl-radio[aria-checked="true"]')
            ?.getAttribute("label"),
        );
      if (p.type === "checkbox") return p.input.checked ? true : "";
      if (p.type === "file") return p.input.files?.length ? "[attached]" : "";
      if (p.type === "date" || p.type === "ui5-date")
        return dateValue(p, p.input.value) || text(p.input.value);
      return p.input.value;
    }
    function describe(node) {
      const p = parts(node);
      if (!p) return null;
      const question = label(p),
        group = [node, p.inner, p.input].filter(Boolean);
      const required =
        group.some(
          (item) =>
            item.required ||
            item.hasAttribute("required") ||
            item.getAttribute("aria-required") === "true",
        ) || /\*\s*$/.test(question);
      const raw = value(node),
        pending = attempts.get(node);
      if (pending && (hasValue(raw) || p.input?.value !== pending.search))
        attempts.delete(node);
      return {
        type:
          p.type === "autocomplete-multiple"
            ? "select-multiple"
            : p.type === "autocomplete"
              ? "combobox"
              : p.type.includes("date")
                ? "date"
                : p.type === "phone"
                  ? "tel"
                  : p.type === "text"
                    ? p.input?.type || "text"
                    : p.type,
        component: "shadow-" + p.type,
        question,
        value: raw,
        group:
          p.type === "radio"
            ? [node, ...node.querySelectorAll("spl-radio")]
            : group,
        required,
        requiredKnown:
          required || !!p.input || node.hasAttribute("aria-required"),
        invalid:
          !!(p.type.includes("date") && raw && !dateValue(p, raw)) ||
          !!p.shadow?.querySelector("spl-internal-form-field[errorstate]") ||
          group.some(
            (item) =>
              item.getAttribute("aria-invalid") === "true" ||
              (item.willValidate &&
                !item.validity.valid &&
                !(
                  p.type === "autocomplete" &&
                  raw &&
                  item.validity.valueMissing
                )),
          ),
        disabled: group.some(
          (item) =>
            item.disabled || item.getAttribute("aria-disabled") === "true",
        ),
        readable:
          !!p.input &&
          (p.type !== "autocomplete" || !!raw || !text(p.input.value)),
        supported:
          !!question &&
          !!p.input &&
          p.type !== "file" &&
          !p.input.disabled &&
          (!p.input.readOnly || p.type === "autocomplete"),
        ...(attempts.has(node) ? { commitState: "unconfirmed" } : {}),
        options:
          p.type === "radio"
            ? radioOptions(node).map((label) => ({ label, value: label }))
            : cachedOptions(node),
      };
    }
    function candidates(p) {
      const options = [
        ...(p.shadow?.querySelectorAll("div[slot='menu'] spl-select-option") ||
          []),
      ].filter(
        (option) =>
          visible(option) &&
          !option.hasAttribute("disabled") &&
          option.getAttribute("aria-disabled") !== "true" &&
          !["goToManualLocationMode", "#spl-no-match-options"].includes(
            option.getAttribute("value"),
          ),
      );
      // SPL adds a custom-text fallback even when a multi-result catalog
      // contains that exact label. It is not a second catalog identity.
      return options.filter(
        (option) =>
          option.getAttribute("value") !== "#spl-custom-option" ||
          !options.some(
            (other) =>
              other.getAttribute("value") !== "#spl-custom-option" &&
              norm(optionLabel(other)) === norm(optionLabel(option)),
          ),
      );
    }
    async function openSearch(p, current) {
      if (!current()) return false;
      JobsPageActions.when(() => p.input.focus());
      // Opening SPL resets its query. Open first, then type the search term,
      // so that the first dropdown-show event cannot erase the search results.
      if (p.shadow.querySelector("spl-dropdown")) {
        const expanded = () =>
          p.input.getAttribute("aria-expanded") === "true" ||
          p.inner?.getAttribute("ariaexpanded") === "true";
        if (expanded()) return current();
        JobsPageActions.click(p.input);
        const opened = await JobsDOMWait.until(() => !current() || expanded(), {
          root: p.shadow,
          timeout: 1500,
          interval: 50,
        });
        return !!opened && current();
      }
      return current();
    }
    function writeSearch(p, answer) {
      p.input.value = answer;
      if (p.type.startsWith("autocomplete"))
        searchWrites.set(p.node, { input: p.input, value: p.input.value });
      const view = p.node.ownerDocument.defaultView;
      JobsPageActions.dispatch(
        p.input,
        new view.Event("input", { bubbles: true }),
      );
      JobsPageActions.dispatch(
        p.input,
        new view.Event("change", { bubbles: true }),
      );
    }
    // An autocomplete is one transaction: its term is typed once, the caller's
    // rule picks among the results as they arrive, and that option is clicked.
    async function operate(
      node,
      answer,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
        pickLabel,
        query,
      } = /** @type {{canProceed?: () => boolean, replace?: boolean, pickLabel?: (labels: string[]) => string | null, query?: string}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      const p = parts(node);
      if (!p?.shadow || !p.input) return null;
      const url = node.ownerDocument.location.href,
        question = label(p);
      let edited = false,
        sending = false;
      const change = (event) => {
        if (event.isTrusted && !sending) edited = true;
      };
      const current = () =>
        JobsPageActions.live(canProceed) &&
        !edited &&
        visible(node) &&
        node.ownerDocument.location.href === url &&
        parts(node)?.input === p.input &&
        label(p) === question &&
        !p.input.disabled &&
        !node.disabled &&
        node.getAttribute("aria-disabled") !== "true" &&
        p.inner?.getAttribute("aria-disabled") !== "true";
      if (
        !current() ||
        (hasValue(value(node)) &&
          p.type !== "autocomplete-multiple" &&
          !replace) ||
        (p.input.readOnly && p.type !== "autocomplete")
      )
        return null;
      p.shadow.addEventListener("input", change, true);
      p.shadow.addEventListener("change", change, true);
      try {
        if (p.type === "radio") {
          const wanted = pickLabel ? pickLabel(radioOptions(node)) : answer;
          const matches = [...node.querySelectorAll("spl-radio")].filter(
            (option) =>
              radioOptions(node).includes(text(option.getAttribute("label"))) &&
              norm(option.getAttribute("label")) === norm(wanted),
          );
          if (!wanted || matches.length !== 1 || !current()) return null;
          JobsPageActions.click(matches[0]);
          const accepted = await JobsDOMWait.until(
            () =>
              !current()
                ? "cancelled"
                : norm(value(node)) === norm(wanted) && !describe(node).invalid,
            { root: node, timeout: 1500 },
          );
          return accepted === true ? node : null;
        }
        if (p.type.startsWith("autocomplete")) {
          const previous = value(node);
          const wanted =
            pickLabel ||
            ((labels) => {
              const same = labels.filter(
                (label) => norm(label) === norm(answer),
              );
              return same.length === 1 ? same[0] : null;
            });
          if (!pickLabel && norm(previous) === norm(answer)) return node;
          const term = query ?? answer;
          if (!(await openSearch(p, current))) return null;
          if (!p.input.readOnly && text(term)) writeSearch(p, String(term));
          const noResults =
            "div[slot='menu'] spl-select-option:first-of-type[value='goToManualLocationMode']";
          const picked = () => {
            const found = candidates(p),
              labels = found.map(optionLabel),
              label = labels.length ? wanted(labels) : null;
            const matches = label
              ? found.filter((option) => optionLabel(option) === label)
              : [];
            return matches.length === 1
              ? { type: "option", el: matches[0], label }
              : null;
          };
          const result = await JobsDOMWait.until(
            () => {
              if (!current()) return { type: "cancelled" };
              if (p.shadow.querySelector(noResults))
                return { type: "noResults" };
              return picked();
            },
            { root: p.shadow, timeout: 3000 },
          );
          if (!result || result.type !== "option") {
            if (current()) {
              p.input.blur();
              node.blur();
            }
            return null;
          }
          if (
            !current() ||
            JSON.stringify(value(node)) !== JSON.stringify(previous)
          )
            return null;
          const option = result.el;
          if (
            p.type === "autocomplete-multiple" &&
            previous.some((label) => norm(label) === norm(result.label))
          )
            return node;
          if (
            !candidates(p).includes(option) ||
            optionLabel(option) !== result.label
          )
            return null;
          sending = true;
          const committed = (event) => {
            if (event.target === node) searchWrites.delete(node);
          };
          node.addEventListener("spl-change", committed);
          try {
            mouseClick(
              option.querySelector(
                ".c-spl-autocomplete-default-option,spl-typography-body",
              ) || option,
            );
            sending = false;
            attempts.set(node, { search: p.input.value });
            const accepted = await JobsDOMWait.until(
              () =>
                !current()
                  ? "cancelled"
                  : (p.type === "autocomplete-multiple"
                      ? [result.label, ...previous].every((label) =>
                          value(node).some(
                            (value) => norm(value) === norm(label),
                          ),
                        )
                      : norm(value(node)) === norm(result.label)) &&
                    !describe(node).invalid,
              { root: p.shadow, timeout: 1500 },
            );
            if (accepted === true) {
              attempts.delete(node);
              return node;
            }
            return null;
          } finally {
            sending = false;
            node.removeEventListener("spl-change", committed);
          }
        }
        if (p.type === "date") {
          // SPL saves through Enter, including both key events and legacy codes.
          writeSearch(p, String(answer));
          const view = node.ownerDocument.defaultView;
          for (const type of ["keydown", "keyup"])
            JobsPageActions.dispatch(
              p.input,
              new view.KeyboardEvent(type, {
                key: "Enter",
                code: "Enter",
                keyCode: 13,
                which: 13,
                bubbles: true,
                composed: true,
                cancelable: true,
              }),
            );
        } else if (p.type === "ui5-date") {
          const view = node.ownerDocument.defaultView;
          node.setAttribute("value", answer);
          p.inner.setAttribute("value", answer);
          p.input.focus();
          p.input.value = answer;
          JobsPageActions.dispatch(
            p.input,
            new view.InputEvent("input", {
              bubbles: true,
              composed: true,
              inputType: "insertText",
              data: answer,
            }),
          );
          JobsPageActions.dispatch(
            p.input,
            new view.Event("change", { bubbles: true, composed: true }),
          );
          JobsPageActions.dispatch(
            p.input,
            new view.FocusEvent("focusout", { bubbles: true, composed: true }),
          );
          JobsPageActions.dispatch(
            node,
            new view.Event("change", { bubbles: true, composed: true }),
          );
        } else if (p.type === "checkbox") {
          sending = true;
          try {
            return await JobsControlFields.writeChecked(p.input, answer, {
              canProceed: current,
            });
          } finally {
            sending = false;
          }
        } else if (p.type === "file") return null;
        else
          return JobsControlFields.writeText(p.input, answer, {
            canProceed: current,
          });
        const expected = dateValue(p, answer);
        return expected &&
          current() &&
          value(node) === expected &&
          !describe(node).invalid
          ? node
          : null;
      } finally {
        p.shadow.removeEventListener("input", change, true);
        p.shadow.removeEventListener("change", change, true);
      }
    }
    function mouseClick(node) {
      const view = node.ownerDocument.defaultView;
      for (const type of ["mouseover", "mousedown", "mouseup", "click"])
        JobsPageActions.dispatch(
          node,
          new view.MouseEvent(type, { bubbles: true, cancelable: true, view }),
        );
      return node;
    }
    const chooseOptions = (
      node,
      pickLabel,
      {
        canProceed,
        replace = false,
        query,
      } = /** @type {{canProceed?: () => boolean, replace?: boolean, query?: string}} */ ({}),
    ) =>
      (parts(node)?.type.startsWith("autocomplete") ||
        parts(node)?.type === "radio") &&
      typeof pickLabel === "function"
        ? operate(node, null, { canProceed, replace, pickLabel, query })
        : null;
    async function chooseUntraced(node, answer, options = {}) {
      const p = parts(node);
      if (!p) return null;
      if (p.type.includes("date") && !dateValue(p, answer)) return null;
      if (p.type === "checkbox" && typeof answer !== "boolean") return null;
      if (
        p.type !== "checkbox" &&
        (typeof answer !== "string" || !answer.trim())
      )
        return null;
      if (p.type === "ui5-date") {
        const date = JobsControlFields.calendarDate(answer);
        answer = `${String(date.month).padStart(2, "0")}/${String(date.day).padStart(2, "0")}/${date.year}`;
      } else if (monthMode(p)) {
        const [year, month] = dateValue(p, answer).split("-");
        answer = `${month}/${year}`;
      }
      return operate(node, answer, options);
    }
    async function readOptions(
      node,
      canProceed = /** @type {() => boolean} */ (() => true),
      { answer } = /** @type {{answer?: string}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      const p = parts(node);
      if (p?.type === "radio")
        return radioOptions(node).map((label) => ({ label, value: label }));
      if (
        !p?.type.startsWith("autocomplete") ||
        !p.input ||
        !p.shadow ||
        !JobsPageActions.live(canProceed) ||
        (p.type !== "autocomplete-multiple" && hasValue(value(node)))
      )
        return [];
      const before = p.input.value,
        question = label(p),
        url = node.ownerDocument.location.href;
      const query = answer;
      let edited = false;
      const change = (event) => {
        if (event.isTrusted) edited = true;
      };
      const current = () =>
        JobsPageActions.live(canProceed) &&
        !edited &&
        visible(node) &&
        parts(node)?.input === p.input &&
        label(p) === question &&
        node.ownerDocument.location.href === url &&
        !p.input.disabled &&
        !node.disabled &&
        node.getAttribute("aria-disabled") !== "true" &&
        (p.type === "autocomplete-multiple" || !hasValue(value(node)));
      p.shadow.addEventListener("input", change, true);
      try {
        if (!(await openSearch(p, current))) return [];
        if (query && current() && !p.input.readOnly)
          writeSearch(p, String(query));
        await JobsDOMWait.until(() => !current() || candidates(p).length, {
          root: p.shadow,
          timeout: 3000,
        });
        if (!current()) return [];
        const labels = candidates(p).map(optionLabel);
        if (
          !labels.length ||
          labels.length > 150 ||
          new Set(labels.map(norm)).size !== labels.length
        )
          return [];
        const options = labels.map((label) => ({ label, value: label }));
        optionsCache.set(node, { options, question, url, input: p.input });
        return options;
      } finally {
        if (
          query &&
          current() &&
          !p.input.readOnly &&
          p.input.value === String(query)
        )
          writeSearch(p, before);
        p.shadow.removeEventListener("input", change, true);
      }
    }
    function cachedOptions(node) {
      const p = parts(node),
        cache = optionsCache.get(node);
      return p &&
        cache &&
        cache.question === label(p) &&
        cache.url === node.ownerDocument.location.href &&
        cache.input === p.input
        ? cache.options
        : undefined;
    }
    // Every entrance (a binding, a known answer, AI, remote review)
    // ends here: record what was asked and what the control holds afterwards.

    // The only public component transaction. Selection belongs to the caller;
    // this component exposes page facts, commits the selection and reads it back.
    async function chooseFrom(node, pick, options = {}) {
      if (parts(node)?.type === "autocomplete-multiple") {
        let selected = [];
        const first = await operate(node, null, {
          ...options,
          pickLabel: (labels) => {
            const choice = pick(labels);
            selected = choice == null ? [] : [choice].flat();
            const existing = value(node);
            if (
              !options.append &&
              existing.some(
                (label) =>
                  !selected.some((wanted) => norm(wanted) === norm(label)),
              )
            )
              return null;
            return (
              selected.find(
                (label) =>
                  !existing.some((value) => norm(value) === norm(label)),
              ) ||
              selected[0] ||
              null
            );
          },
        });
        if (!first) return null;
        for (const label of selected) {
          if (value(node).some((value) => norm(value) === norm(label)))
            continue;
          if (
            !(await operate(node, label, {
              ...options,
              replace: true,
              query: label,
            }))
          )
            return null;
        }
        return node;
      }
      if (
        !parts(node)?.type.startsWith("autocomplete") &&
        parts(node)?.type !== "radio"
      )
        return chooseUntraced(node, pick([]), options);
      return chooseOptions(node, pick, options);
    }
    JobsShadowControls = {
      find,
      isControl,
      describe,
      value,
      chooseFrom,
      readOptions,
      cachedOptions,
      multiple: (node) => parts(node)?.type === "autocomplete-multiple",
    };
  })();
}
