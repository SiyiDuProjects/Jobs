import { JobsControlFields } from "./control-fields.js";
import { JobsPageActions } from "./page-actions.js";
import { JobsDOMWait } from "./dom-wait.js";
import { JobsDiagnostics } from "./diagnostics.js";
import { JobsOptionMatch } from "./option-match.js";
export var JobsIcimsControls;
let initialized = false;
export function initializeIcimsControls() {
  if (initialized) return;
  initialized = true;
  // iCIMS dropdowns and segmented dates: one reader/writer for every entrance.
  // A choice needs a unique label and an agreeing visible/backing value.
  (() => {
    const normalize = (value) =>
      String(value ?? "")
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
    const text = (value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const cache = new WeakMap();
    const cancelled = {};
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
    function parts(node) {
      if (!node?.matches?.('a[role="combobox"],a[id$="_icimsDropdown"]'))
        return null;
      const host = node.parentElement;
      if (!host) return null;
      const selects = [
        ...host.querySelectorAll('select[icimsdropdown-enabled="1"]'),
      ];
      const ownId = node.id.replace(/_icimsDropdown$/, "");
      const identified = selects.filter(
        (select) => select.id && select.id === ownId,
      );
      const select =
        identified.length === 1
          ? identified[0]
          : selects.length === 1
            ? selects[0]
            : null;
      // Never use a neighbouring question's popup. A unique local wrapper is
      // required even when this tenant does not supply aria-controls.
      const containers = [
        ...host.querySelectorAll(".dropdown-container"),
      ].filter(
        (container) =>
          !container.parentElement.closest(".dropdown-container") ||
          !host.contains(
            container.parentElement.closest(".dropdown-container"),
          ),
      );
      const linked = node.ownerDocument.getElementById(
        node.getAttribute("aria-controls"),
      );
      const linkedContainer = linked?.closest(".dropdown-container");
      const container =
        linkedContainer && host.contains(linkedContainer)
          ? linkedContainer
          : containers.length === 1
            ? containers[0]
            : null;
      const inputs =
        container?.querySelectorAll('input:not([type="hidden"])') || [];
      const lists = container?.querySelectorAll("ul") || [];
      return {
        node,
        host,
        select,
        container,
        input: inputs.length === 1 ? inputs[0] : null,
        list: lists.length === 1 ? lists[0] : null,
      };
    }
    function isControl(node) {
      if (dateParts(node)) return true;
      const control = parts(node);
      return (
        !!control && (!!control.select || node.id.endsWith("_icimsDropdown"))
      );
    }
    function find(scope = document) {
      return [
        scope,
        ...scope.querySelectorAll(
          '.iCIMS_Forms_DateOnlyField,a[role="combobox"],a[id$="_icimsDropdown"],input',
        ),
      ].filter((node) => isControl(node) && visible(node));
    }
    function dateParts(node) {
      if (!node?.matches?.(".iCIMS_Forms_DateOnlyField")) return null;
      const members = ["Month", "Day", "Year"].map((part) => [
        ...node.querySelectorAll(".iCIMS_Forms_" + part + "Input"),
      ]);
      return members.every((part) => part.length === 1)
        ? members.map((part) => part[0])
        : null;
    }
    function dateQuestion(node) {
      const row = node.closest(
        '.iCIMS_FieldRow,[role="group"][aria-labelledby]',
      );
      const labels = text(row?.getAttribute("aria-labelledby"))
        .split(" ")
        .filter(Boolean);
      return text(
        labels
          .map((id) => node.ownerDocument.getElementById(id)?.textContent || "")
          .join(" ") ||
          row?.querySelector('.iCIMS_InfoField label:not([id$="_desc"])')
            ?.textContent,
      ).replace(/^Error\s*:\s*/i, "");
    }
    function dateValue(node) {
      const values = dateParts(node).map((part) =>
        text(part.value).replace(/^0$/, ""),
      );
      if (values.every((value) => !value)) return "";
      return (
        JobsControlFields.calendarDate(values.join("/"))?.iso ||
        values.map((value) => value || "__").join("/")
      );
    }
    async function chooseDate(
      node,
      answer,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
      } = {},
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      const parts = dateParts(node),
        date = JobsControlFields.calendarDate(answer);
      if (!parts || !date || (value(node) && !replace)) return null;
      const url = node.ownerDocument.location.href,
        label = dateQuestion(node);
      const current = () =>
        JobsPageActions.live(canProceed) &&
        node.ownerDocument.location.href === url &&
        dateQuestion(node) === label &&
        parts.every(
          (part, index) =>
            dateParts(node)?.[index] === part &&
            visible(part) &&
            !part.disabled &&
            !part.readOnly,
        );
      // Validate all three targets before changing any one of them.
      const chosen = [date.month, date.day].map((number, index) =>
        [...parts[index].options].filter(
          (option) => !option.disabled && Number(option.value) === number,
        ),
      );
      if (!current() || chosen.some((options) => options.length !== 1))
        return null;
      for (let index = 0; index < 2; index++) {
        if (
          !current() ||
          !JobsControlFields.writeSelect(parts[index], [chosen[index][0].value])
        )
          return null;
      }
      if (
        !(await JobsControlFields.writeText(parts[2], String(date.year), {
          canProceed: current,
          blur: true,
        }))
      )
        return null;
      return current() && dateValue(node) === date.iso ? node : null;
    }
    function value(node) {
      if (dateParts(node)) return dateValue(node);
      const select = parts(node)?.select;
      if (!select?.value || ["-1", "-999"].includes(select.value)) return "";
      const selected = text(select.selectedOptions[0]?.textContent);
      // AJAX initialization can reset the visible widget to its placeholder while
      // leaving the backing select populated. That is not a committed selection:
      // dependent fields (for example State after Country) still have no choices.
      // Older variants without this display element retain their original readback.
      const display = node.querySelector(".dropdown-text");
      if (
        display &&
        (display.querySelector(".dropdown-placeholder") ||
          normalize(display.textContent) !== normalize(selected))
      )
        return "";
      return selected;
    }
    function question(control) {
      const { node, select, host } = control;
      const labelledBy = text(node.getAttribute("aria-labelledby"))
        .split(" ")
        .filter(Boolean)
        .map((id) => node.ownerDocument.getElementById(id)?.textContent || "")
        .join(" ");
      return text(
        labelledBy ||
          node.getAttribute("aria-label") ||
          [...(select?.labels || [])]
            .map((label) => label.textContent)
            .join(" ") ||
          select?.getAttribute("data-label") ||
          host.querySelector("label")?.textContent ||
          "",
      ).replace(/^Error\s*:\s*/i, "");
    }
    function cachedOptions(node) {
      const item = cache.get(node),
        control = parts(node);
      return item &&
        control?.select === item.select &&
        control?.list === item.list &&
        question(control) === item.question
        ? item.options
        : undefined;
    }
    function dependencies(control) {
      const parent = control.select?.getAttribute("data-ddd-parent-link");
      if (!parent) return [];
      // iCIMS declares the cascade. Scope repeated addresses to their own
      // collection; never link a second address's State to the first Country.
      const scope =
        control.node.closest("fieldset.iCIMS_CollectionGroup") ||
        control.node.closest("form");
      const matches = [...(scope?.querySelectorAll("select") || [])].filter(
        (select) => select.id === parent || select.id.endsWith("_" + parent),
      );
      if (matches.length !== 1) return [null];
      const select = matches[0];
      if (select.getAttribute("icimsdropdown-enabled") !== "1") return [select];
      const trigger = select.ownerDocument.getElementById(
        select.id + "_icimsDropdown",
      );
      return [trigger && parts(trigger)?.select === select ? trigger : null];
    }
    function describe(node) {
      const date = dateParts(node);
      if (date) {
        const row = node.closest(".iCIMS_FieldRow"),
          answer = dateValue(node);
        const required =
          [node, ...date].some(
            (item) =>
              item.required ||
              item.getAttribute("aria-required") === "true" ||
              item.getAttribute("i_required") === "true" ||
              item.classList.contains("iCIMS_Forms_RequiredField"),
          ) || !!row?.querySelector(".iCIMS_InfoField .Field_Required");
        return {
          type: "date",
          component: "icims-date",
          question: dateQuestion(node),
          value: answer,
          group: date,
          dateParts: date,
          required,
          requiredKnown: true,
          readable: true,
          invalid:
            !!(answer && !JobsControlFields.calendarDate(answer)) ||
            !!row?.classList.contains("iCIMS_HasError") ||
            date.some((part) => part.getAttribute("aria-invalid") === "true"),
          supported:
            date.every(
              (part) => visible(part) && !part.disabled && !part.readOnly,
            ) && !!dateQuestion(node),
        };
      }
      const control = parts(node);
      if (!control) return null;
      const label = question(control),
        group = [
          ...new Set(
            [
              node,
              control.select,
              control.container,
              ...(control.container?.querySelectorAll("input,ul,li") || []),
            ].filter(Boolean),
          ),
        ];
      const required =
        [node, control.select]
          .filter(Boolean)
          .some(
            (item) =>
              item.required ||
              item.getAttribute("aria-required") === "true" ||
              item.getAttribute("i_required") === "true" ||
              item.classList.contains("iCIMS_Forms_RequiredField"),
          ) || /\*\s*$/.test(label);
      const invalid = group.some(
        (item) =>
          item.getAttribute("aria-invalid") === "true" ||
          (item.willValidate &&
            !item.validity.valid &&
            !(
              item === control.input &&
              value(node) &&
              item.validity.valueMissing
            )),
      );
      const disabled =
        !!control.select?.disabled ||
        node.getAttribute("aria-disabled") === "true";
      return {
        type: "combobox",
        question: label,
        value: value(node),
        group,
        required,
        dependsOn: dependencies(control),
        requiredKnown:
          !!control.select || required || node.hasAttribute("aria-required"),
        invalid,
        disabled,
        readable: !!control.select,
        supported: !!(
          control.select &&
          !control.select.multiple &&
          control.input &&
          control.list &&
          label &&
          !disabled &&
          ((!control.input.disabled && !control.input.readOnly) ||
            options(control).length)
        ),
        options: cachedOptions(node),
      };
    }
    const options = (control) =>
      [
        ...(control.list?.querySelectorAll(
          'li[role="option"],li[dropdown-index]',
        ) || []),
      ].filter(
        (option) =>
          option.getAttribute("dropdown-index") !== "-1" &&
          option.getAttribute("aria-disabled") !== "true",
      );
    const optionLabel = (option) =>
      text(option.getAttribute("title") || option.textContent);
    const exactOption = (control, answer, visibleOnly = false) => {
      const wanted = normalize(answer),
        matches = options(control).filter(
          (option) =>
            (!visibleOnly || visible(option)) &&
            (normalize(option.getAttribute("title")) === wanted ||
              normalize(option.textContent) === wanted),
        );
      return matches.length === 1 ? matches[0] : null;
    };
    async function wait(read, control, current, timeout) {
      const result = await JobsDOMWait.until(
        () => (current() ? read() : cancelled),
        { root: control.host, timeout },
      );
      return current() && result !== cancelled ? result : null;
    }
    const writeSearch = (control, answer, current) =>
      JobsControlFields.writeText(control.input, answer, {
        blur: true,
        keyboard: true,
        click: true,
        canProceed: current,
      });
    function mouseClick(option) {
      const view = option.ownerDocument.defaultView;
      for (const type of ["mouseover", "mousedown", "mouseup", "click"])
        JobsPageActions.dispatch(
          option,
          new view.MouseEvent(type, { bubbles: true, cancelable: true, view }),
        );
    }
    async function chooseUntraced(
      node,
      answer,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
      } = /** @type {{canProceed?: () => boolean, replace?: boolean}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (dateParts(node))
        return chooseDate(node, answer, { canProceed, replace });
      const control = parts(node),
        wanted = normalize(answer);
      const note = (type, detail) => JobsDiagnostics?.note(type, node, detail);
      note("option_requested", answer);
      if (
        !control?.select ||
        control.select.multiple ||
        !wanted ||
        !control.input ||
        !control.list
      ) {
        note("option_failed", "missing_control");
        return null;
      }
      const url = node.ownerDocument.location.href,
        previous = value(node),
        initialQuestion = question(control);
      let edited = false;
      let sending = false;
      const userEdit = (event) => {
        if (event.isTrusted && !sending) edited = true;
      };
      const current = () =>
        JobsPageActions.live(canProceed) &&
        !edited &&
        node.ownerDocument.location.href === url &&
        question(control) === initialQuestion &&
        node.isConnected &&
        control.input.isConnected &&
        control.select.isConnected &&
        visible(node) &&
        !control.select.disabled &&
        node.getAttribute("aria-disabled") !== "true" &&
        parts(node)?.input === control.input &&
        parts(node)?.list === control.list &&
        parts(node)?.select === control.select;
      if (!current()) return null;
      if (normalize(previous) === wanted) {
        note("option_verified", answer);
        return node;
      }
      if (previous && !replace) return null;
      const findOption = () =>
        current() ? exactOption(control, answer, true) : null;
      control.input.addEventListener("input", userEdit);
      control.select.addEventListener("change", userEdit);
      try {
        let option = findOption();
        if (!option) {
          if (node.getAttribute("aria-expanded") !== "true")
            JobsPageActions.click(node);
          if (!current()) return null;
          // A closed popup may already have its exact result. Opening it makes
          // that result usable without editing a readonly search input. Hidden
          // stale options remain excluded.
          option = findOption();
          if (!option) {
            if (control.input.disabled || control.input.readOnly) {
              note("option_failed", "search_input_not_writable");
              return null;
            }
            if (!(await writeSearch(control, answer, current))) return null;
            option = await wait(
              () => normalize(control.input.value) === wanted && findOption(),
              control,
              current,
              3000,
            );
          }
        }
        if (
          !option ||
          !current() ||
          findOption() !== option ||
          value(node) !== previous
        ) {
          note("option_failed", "exact_match_not_ready");
          return null;
        }
        note("option_clicked", optionLabel(option));
        sending = true;
        try {
          mouseClick(option);
        } finally {
          sending = false;
        }
        const committed = await wait(
          () => normalize(value(node)) === wanted,
          control,
          current,
          1500,
        );
        note(
          committed ? "option_verified" : "option_failed",
          committed ? answer : "selection_not_committed",
        );
        return committed ? node : null;
      } finally {
        control.input.removeEventListener("input", userEdit);
        control.select.removeEventListener("change", userEdit);
      }
    }
    // The field's own catalog: the backing select lists every option, loaded or not.
    const catalog = (control) =>
      [...control.select.options]
        .filter(
          (option) =>
            option.value &&
            !["-1", "-999"].includes(option.value) &&
            !option.disabled,
        )
        .map((option) => text(option.textContent));
    // One transaction: the rule picks from the catalog and that label is
    // searched once and committed. A remote search whose catalog is not loaded
    // types the term once; the rule picks among its results, and the listed
    // option is committed without searching again.
    async function chooseOptions(
      node,
      pickLabel,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
        query,
      } = /** @type {{canProceed?: () => boolean, replace?: boolean, query?: string}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (dateParts(node) || typeof pickLabel !== "function") return null;
      const control = parts(node);
      if (
        !control?.select ||
        control.select.multiple ||
        !control.input ||
        !control.list
      )
        return null;
      const url = node.ownerDocument.location.href,
        initialQuestion = question(control),
        previous = value(node);
      const current = () =>
        JobsPageActions.live(canProceed) &&
        node.ownerDocument.location.href === url &&
        question(control) === initialQuestion &&
        visible(node) &&
        !control.select.disabled &&
        node.getAttribute("aria-disabled") !== "true" &&
        parts(node)?.input === control.input &&
        parts(node)?.list === control.list &&
        parts(node)?.select === control.select;
      const pickVisible = () =>
        current()
          ? pickLabel(
              options(control).filter(visible).map(optionLabel).filter(Boolean),
            )
          : null;
      const fail = () => {
        JobsDiagnostics?.note("option_failed", node, "exact_match_not_ready");
        return null;
      };
      if (!current() || (previous && !replace)) return null;
      // Loaded choices come first, including a readonly search input. Opening
      // a closed list exposes its current options without typing a new query.
      let selected = pickVisible();
      if (!selected && node.getAttribute("aria-expanded") !== "true") {
        JobsPageActions.click(node);
        selected = pickVisible();
      }
      if (!current()) return null;
      if (!selected) {
        const known = catalog(control);
        selected = known.length ? pickLabel(known) : null;
      }
      if (selected)
        return value(node) === previous
          ? chooseUntraced(node, selected, { canProceed: current, replace })
          : null;
      if (!query || control.input.disabled || control.input.readOnly)
        return fail();
      if (!(await writeSearch(control, String(query), current))) return null;
      const picked = await wait(
        () =>
          normalize(control.input.value) === normalize(query) && pickVisible(),
        control,
        current,
        3000,
      );
      return picked && current() && value(node) === previous
        ? chooseUntraced(node, picked, { canProceed: current, replace })
        : fail();
    }
    async function readOptions(
      node,
      canProceed = /** @type {() => boolean} */ (() => true),
      {
        answer,
        optionSpec,
      } = /** @type {{answer?: string, optionSpec?: import('./control-types.js').ControlAnswerSpec}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (dateParts(node)) return [];
      const control = parts(node);
      if (
        !control?.select ||
        control.select.multiple ||
        !control.input ||
        !control.list
      )
        return [];
      const url = node.ownerDocument.location.href,
        initialQuestion = question(control);
      const current = () =>
        JobsPageActions.live(canProceed) &&
        node.ownerDocument.location.href === url &&
        question(control) === initialQuestion &&
        visible(node) &&
        control.input.isConnected &&
        control.select.isConnected &&
        !control.select.disabled &&
        node.getAttribute("aria-disabled") !== "true" &&
        parts(node)?.input === control.input &&
        parts(node)?.list === control.list &&
        parts(node)?.select === control.select;
      if (!current()) return [];
      // Non-search iCIMS lists are already loaded. Read their own list without
      // opening optional Prefix/Suffix before reaching required questions below.
      if (control.select.getAttribute("icimsdropdown-search") === "0") {
        const labels = options(control).map(optionLabel).filter(Boolean);
        if (
          labels.length &&
          labels.length <= 150 &&
          new Set(labels.map(normalize)).size === labels.length
        ) {
          const answers = labels.map((label) => ({ label, value: label }));
          cache.set(node, {
            select: control.select,
            list: control.list,
            question: question(control),
            options: answers,
          });
          return answers;
        }
      }
      const previous = value(node),
        previousSearch = control.input.value,
        opened = node.getAttribute("aria-expanded") !== "true";
      let query;
      const same = () => current() && value(node) === previous;
      const available = () => options(control).filter(visible);
      try {
        if (opened) JobsPageActions.click(node);
        if (!same()) return [];
        if (!available().length) {
          if (control.input.readOnly || control.input.disabled) return [];
          // When the backing catalog already names an equivalent option, search
          // its own wording (e.g. Opt Out), not just the spec's first alias. The
          // shared matcher decides equivalence; selection still needs a live
          // result and agreeing visible/backing values.
          const known =
            optionSpec && JobsOptionMatch?.pick(catalog(control), optionSpec);
          query = known?.label ?? answer;
          if (query && !(await writeSearch(control, String(query), same)))
            return [];
        }
        const result = await wait(
          () => (available().length ? available() : null),
          control,
          same,
          3000,
        );
        const labels = result?.map(optionLabel).filter(Boolean) || [];
        if (
          !same() ||
          !labels.length ||
          labels.length > 150 ||
          new Set(labels.map(normalize)).size !== labels.length
        ) {
          cache.delete(node);
          return [];
        }
        const answers = labels.map((label) => ({ label, value: label }));
        cache.set(node, {
          select: control.select,
          list: control.list,
          question: question(control),
          options: answers,
        });
        return answers;
      } finally {
        if (same()) {
          if (query && control.input.value === String(query))
            await writeSearch(control, previousSearch, same);
          if (opened && same() && node.getAttribute("aria-expanded") === "true")
            JobsPageActions.click(node);
        }
      }
    }
    // Every entrance (a binding, a known answer, AI, remote review)
    // ends here: record what was asked and what the control holds afterwards.

    // The only public component transaction. Selection belongs to the caller;
    // this component exposes page facts, commits the selection and reads it back.
    async function chooseFrom(node, pick, options = {}) {
      if (dateParts(node)) return chooseDate(node, pick([]), options);
      return chooseOptions(node, pick, options);
    }
    JobsIcimsControls = {
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
