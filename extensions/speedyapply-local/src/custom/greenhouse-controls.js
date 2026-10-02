import { JobsPageActions } from "./page-actions.js";
import { JobsControlFields } from "./control-fields.js";
import { JobsDOMWait } from "./dom-wait.js";
import { JobsDiagnostics } from "./diagnostics.js";
import { JobsProfileAnswers } from "./profile-answers.js";
import { JobsOptionMatch } from "./option-match.js";
export var JobsGreenhouseControls;
let initialized = false;
export function initializeGreenhouseControls() {
  if (initialized) return;
  initialized = true;
  // Greenhouse's React Select search controls, including embedded job forms.
  // Reuse the common native input writer and bounded DOM wait used by Workday.
  (() => {
    const normalize = (value) =>
      String(value ?? "")
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[,\s\-–—]+/g, " ")
        .trim();
    function isControl(node) {
      return (
        !!node?.matches('input.select__input[role="combobox"]') &&
        !!node.closest(".select")
      );
    }
    // Location and education school lists are remote searches: they list
    // nothing until a term is typed. Other lists are read whole first.
    const searchable = (node) =>
      isControl(node) &&
      (node.id === "candidate-location" || /^school--\d+$/.test(node.id));
    // The education entry a school--N field belongs to (page structure).
    const educationIndex = (node) => {
      const index = node.id.match(/^school--(\d+)$/)?.[1];
      return index === undefined ? undefined : Number(index);
    };
    // A remote search types its term; a fixed list is read whole first, then
    // filtered with the term like a person typing it (a country picker has ~240 entries).
    const plan = (input, term) =>
      searchable(input) ? (term ? [term] : []) : ["", ...(term ? [term] : [])];
    const cache = new WeakMap();
    const committedLabels = new WeakMap();
    const watched = new WeakSet();
    function rememberSelection(node, label) {
      committedLabels.set(node, {
        label,
        shown: selected(node),
        title: title(node),
        url: node.ownerDocument.location.href,
      });
      if (watched.has(node)) return;
      watched.add(node);
      // Compact displays may show only a dialing code. Keep the actual clicked
      // label only until a person edits or reopens this same control.
      for (const event of ["pointerdown", "keydown", "input", "change"])
        node.addEventListener(event, (entry) => {
          if (entry.isTrusted) committedLabels.delete(node);
        });
    }
    const supported = isControl;
    const multiple = (node) =>
      isControl(node) &&
      !!node
        .closest(".select")
        .querySelector(".select__value-container--is-multi");
    const selected = (node) =>
      node
        ?.closest(".select")
        ?.querySelector(".select__single-value")
        ?.textContent?.trim() || "";
    const value = (node) => {
      const pills = [
        ...node
          .closest(".select")
          .querySelectorAll(".select__multi-value__label"),
      ]
        .map((item) => item.textContent.trim())
        .filter(Boolean);
      if (multiple(node) || pills.length) return pills;
      const remembered = committedLabels.get(node),
        shown = selected(node);
      return remembered &&
        remembered.shown === shown &&
        remembered.title === title(node) &&
        remembered.url === node.ownerDocument.location.href
        ? remembered.label
        : shown;
    };
    const title = (node) =>
      node.closest(".select")?.querySelector("label")?.textContent || "";
    const cachedOptions = (node) =>
      cache.get(node)?.title === title(node)
        ? cache.get(node).options
        : undefined;
    const press = (input, key) => {
      const view = input.ownerDocument.defaultView;
      // Greenhouse's controlled wrapper listens to keyup.code, while the inner
      // React Select listens to keydown.key. Both halves are required.
      for (const type of ["keydown", "keyup"])
        JobsPageActions.dispatch(
          input,
          new view.KeyboardEvent(type, {
            key,
            code: key,
            bubbles: true,
            cancelable: true,
          }),
        );
    };
    const open = (input) => {
      input.focus();
      // Preserve the original adapter's complete mouse sequence. The controlled
      // Greenhouse wrapper additionally requires keyup.code (below).
      if (input.getAttribute("aria-expanded") !== "true")
        for (const type of ["mouseover", "mousedown", "mouseup", "click"])
          JobsPageActions.dispatch(
            input,
            new input.ownerDocument.defaultView.MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              view: input.ownerDocument.defaultView,
            }),
          );
      if (input.getAttribute("aria-expanded") !== "true")
        press(input, "ArrowDown");
    };
    const close = (input) => {
      if (input.getAttribute("aria-expanded") === "true")
        press(input, "Escape");
    };
    async function candidates(input, query, current, previous = "") {
      const doc = input.ownerDocument,
        reader = JobsControlFields.create(doc);
      if (!current()) return [];
      if (
        query &&
        !(await JobsControlFields.writeText(input, query, {
          blur: false,
          canProceed: current,
        }))
      )
        return [];
      open(input);
      let empty = 0;
      const result = await JobsDOMWait.until(
        () => {
          if (
            !current() ||
            input.value !== query ||
            selected(input) !== previous
          )
            return [];
          const box = input.closest(".select");
          // A "No options" notice that stays (not the instant a menu opens before
          // its search starts) is a final empty result for this query, not a
          // reason to wait out the timeout.
          if (
            !box.querySelector(".select__menu-notice--loading") &&
            box.querySelector(".select__menu-notice--no-options")
          ) {
            empty ||= Date.now();
            return Date.now() - empty >= 150 ? [] : null;
          }
          empty = 0;
          const popup = doc.getElementById(input.getAttribute("aria-controls"));
          if (
            !popup ||
            popup.getAttribute("role") !== "listbox" ||
            !reader.visible(popup)
          )
            return null;
          if (
            (popup.getAttribute("aria-multiselectable") === "true") !==
            multiple(input)
          )
            return [];
          if (
            input
              .closest(".select")
              .querySelector(".select__menu-notice--loading") ||
            popup.getAttribute("aria-busy") === "true"
          )
            return null;
          const options = [...popup.querySelectorAll('[role="option"]')].filter(
            (node) =>
              reader.visible(node) &&
              node.getAttribute("aria-disabled") !== "true",
          );
          return options.length ? options : null;
        },
        { root: doc, timeout: 2500, interval: 100 },
      );
      JobsDiagnostics?.note(
        "auto_dropdown_observed",
        input,
        JSON.stringify({
          expanded: input.getAttribute("aria-expanded") === "true",
          linkedPopup: !!doc.getElementById(
            input.getAttribute("aria-controls"),
          ),
          options: result?.length || 0,
          cancelled: !current(),
        }),
      );
      return current() ? result || [] : [];
    }
    async function readOptions(
      input,
      canProceed = /** @type {() => boolean} */ (() => true),
      {
        answer,
        optionSpec,
      } = /** @type {{answer?: string, optionSpec?: import('./control-types.js').ControlAnswerSpec}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (
        !supported(input) ||
        selected(input) ||
        input.disabled ||
        input.readOnly
      )
        return [];
      const reader = JobsControlFields.create(input.ownerDocument),
        url = input.ownerDocument.location.href;
      const current = () =>
        JobsPageActions.live(canProceed) &&
        reader.visible(input) &&
        input.ownerDocument.location.href === url &&
        !input.disabled &&
        !input.readOnly;
      const requested = typeof answer === "string" ? answer.trim() : "",
        spec =
          optionSpec ||
          JobsProfileAnswers.literalSpec("known-answer", requested);
      if (searchable(input) && !requested) return [];
      let query = "",
        listed = false;
      JobsDiagnostics?.note("auto_options_wait", input, "Greenhouse");
      try {
        for (query of plan(input, requested)) {
          const nodes = await candidates(input, query, current);
          const labels = nodes
            .map((node) => node.textContent.trim())
            .filter(Boolean);
          if (multiple(input))
            for (const label of value(input))
              if (!labels.includes(label)) labels.push(label);
          if (!query && labels.length) listed = true;
          // A search that lists nothing until typed exposes only the candidate
          // its rule verifies, not unrelated schools/places for a model to guess from.
          const search = !!query && !listed;
          const relevant = search
            ? labels.filter(
                (label) => spec && JobsOptionMatch.pick([label], spec),
              )
            : labels;
          if (
            relevant.length &&
            (!search || relevant.length === 1) &&
            relevant.length <= 150 &&
            new Set(relevant).size === relevant.length
          ) {
            const options = relevant.map((label) => ({ value: label, label }));
            cache.set(input, { title: title(input), options });
            JobsDiagnostics?.note(
              "auto_options_ready",
              input,
              String(options.length),
            );
            return options;
          }
          if (!current()) return [];
        }
        cache.delete(input);
        JobsDiagnostics?.note(
          "auto_options_unavailable",
          input,
          "No unambiguous matching candidates",
        );
        return [];
      } finally {
        if (current()) {
          close(input);
          if (query && input.value === query && !selected(input))
            await JobsControlFields.writeText(input, "", {
              blur: false,
              canProceed: current,
            });
        }
      }
    }
    async function chooseUntraced(
      input,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
        append = false,
        pickFrom,
        term = "",
      } = /** @type {{canProceed?: () => boolean, replace?: boolean, append?: boolean, pickFrom?: (labels: string[]) => string | null, term?: string}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (
        !supported(input) ||
        input.disabled ||
        input.readOnly ||
        typeof pickFrom !== "function" ||
        !JobsPageActions.live(canProceed)
      )
        return null;
      const pick = (options) => {
        const labels = options.map((option) => option.textContent.trim()),
          label = labels.length ? pickFrom(labels) : null;
        const matches = label
          ? options.filter((option) => option.textContent.trim() === label)
          : [];
        return matches.length === 1 ? matches[0] : null;
      };
      if (multiple(input)) return null;
      // Search text is not a selection. Preserve every existing committed value.
      const previous = selected(input);
      if (previous && !replace) return input;
      const doc = input.ownerDocument,
        url = doc.location.href;
      const scope = input.closest(".select");
      const reader = JobsControlFields.create(doc);
      let edited = false;
      const userEdit = (event) => {
        if (event.isTrusted) edited = true;
      };
      const current = () =>
        JobsPageActions.live(canProceed) &&
        !edited &&
        doc.location.href === url &&
        reader.visible(input) &&
        !input.disabled &&
        !input.readOnly;
      let query = "";
      const list = () => {
        const popup = doc.getElementById(input.getAttribute("aria-controls"));
        return popup?.getAttribute("role") === "listbox" &&
          reader.visible(popup)
          ? popup
          : null;
      };
      const find = () => {
        const popup = list();
        if (
          !popup ||
          popup.getAttribute("aria-multiselectable") === "true" ||
          scope.querySelector(".select__menu-notice--loading") ||
          popup.getAttribute("aria-busy") === "true"
        )
          return null;
        const options = [...popup.querySelectorAll('[role="option"]')].filter(
          (option) =>
            reader.visible(option) &&
            option.getAttribute("aria-disabled") !== "true",
        );
        return pick(options);
      };
      const note = (detail) =>
        JobsDiagnostics?.note("auto_search_select", input, detail);
      input.addEventListener("input", userEdit);
      try {
        let option;
        for (query of plan(input, term)) {
          await candidates(input, query, current, previous);
          if (
            !current() ||
            input.value !== query ||
            selected(input) !== previous
          )
            return null;
          option = find();
          if (option) break;
        }
        if (!current() || !option || option.cancelled || option !== find()) {
          note("Matching result unavailable");
          return null;
        }
        const label = option.textContent.trim();
        JobsPageActions.click(option);
        const committed = await JobsDOMWait.until(
          () => {
            if (!current()) return { cancelled: true };
            const error = doc.getElementById(
              input.getAttribute("aria-errormessage"),
            );
            // A compact display shows only the option's trailing part (a phone
            // country picker shows "+1" for "United States +1").
            const shown = normalize(selected(input));
            return (
              (shown === normalize(label) ||
                (!!shown &&
                  shown !== normalize(previous) &&
                  normalize(label).endsWith(" " + shown))) &&
              input.getAttribute("aria-expanded") !== "true" &&
              input.getAttribute("aria-invalid") !== "true" &&
              !(error && reader.visible(error) && error.textContent.trim())
            );
          },
          { root: doc, timeout: 1500 },
        );
        if (!committed || committed.cancelled || !current()) {
          note("Selection was not committed");
          return null;
        }
        rememberSelection(input, label);
        note("Selection committed");
        return input;
      } finally {
        input.removeEventListener("input", userEdit);
        // Escape closes without accepting a highlighted default (unlike Tab/Enter).
        if (current()) {
          close(input);
          if (!selected(input) && input.value === query)
            await JobsControlFields.writeText(input, "", {
              blur: false,
              canProceed: current,
            });
        }
      }
    }
    // One operation for the shared semantic entrance: this search term, the
    // caller's rule picking from its current results, and that option committed
    // from the open list. A value is never searched twice.
    async function chooseOptions(
      input,
      pickLabel,
      {
        canProceed,
        replace = false,
        append = false,
        query = "",
      } = /** @type {{canProceed?: () => boolean, replace?: boolean, append?: boolean, query?: string}} */ ({}),
    ) {
      return chooseUntraced(input, {
        canProceed,
        replace,
        append,
        pickFrom: pickLabel,
        term: String(query ?? "").trim(),
      });
    }
    async function chooseMultipleUntraced(
      input,
      answers,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
        available,
      } = /** @type {{canProceed?: () => boolean, replace?: boolean, available?: import('./control-types.js').ControlOption[]}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (
        !multiple(input) ||
        !Array.isArray(answers) ||
        answers.length > 150 ||
        answers.some(
          (answer) => typeof answer !== "string" || !answer.trim(),
        ) ||
        new Set(answers).size !== answers.length
      )
        return null;
      const doc = input.ownerDocument,
        url = doc.location.href,
        reader = JobsControlFields.create(doc);
      let edited = false;
      const touched = (event) => {
        if (event.isTrusted) edited = true;
      };
      const current = () =>
        JobsPageActions.live(canProceed) &&
        !edited &&
        reader.visible(input) &&
        doc.location.href === url &&
        !input.disabled &&
        !input.readOnly;
      const same = (a, b) =>
        a.length === b.length && a.every((label) => b.includes(label));
      let expected = value(input);
      if (
        !current() ||
        (expected.length && !replace && !same(expected, answers))
      )
        return null;
      if (same(expected, answers)) return input;
      for (const event of ["input", "keydown", "pointerdown"])
        input.addEventListener(event, touched);
      try {
        const options = available || (await readOptions(input, current));
        if (
          !current() ||
          !same(value(input), expected) ||
          answers.some(
            (answer) => !options.some((option) => option.value === answer),
          )
        )
          return null;
        const accepted = async () =>
          !!(await JobsDOMWait.until(
            () =>
              current() &&
              same(value(input), expected) &&
              input.getAttribute("aria-expanded") !== "true",
            { root: doc, timeout: 1500 },
          ));
        for (const label of expected.filter(
          (label) => !answers.includes(label),
        )) {
          if (!current() || !same(value(input), expected)) return null;
          const pills = [
            ...input
              .closest(".select")
              .querySelectorAll(".select__multi-value"),
          ].filter(
            (pill) =>
              pill
                .querySelector(".select__multi-value__label")
                ?.textContent.trim() === label,
          );
          const remove =
            pills.length === 1 &&
            pills[0].querySelector(".select__multi-value__remove");
          if (!remove || remove.getAttribute("aria-disabled") === "true")
            return null;
          expected = expected.filter((item) => item !== label);
          JobsPageActions.click(remove);
          if (!(await accepted())) return null;
        }
        for (const label of answers.filter(
          (label) => !expected.includes(label),
        )) {
          if (!current() || !same(value(input), expected)) return null;
          const nodes = await candidates(input, "", current),
            matches = nodes.filter((node) => node.textContent.trim() === label);
          if (
            !current() ||
            !same(value(input), expected) ||
            matches.length !== 1
          )
            return null;
          expected = [...expected, label];
          JobsPageActions.click(matches[0]);
          if (!(await accepted())) return null;
        }
        return current() &&
          same(value(input), answers) &&
          input.getAttribute("aria-invalid") !== "true"
          ? input
          : null;
      } finally {
        for (const event of ["input", "keydown", "pointerdown"])
          input.removeEventListener(event, touched);
        if (current()) close(input);
      }
    }
    // Every entrance (a binding, a known answer, AI, remote review)
    // ends here: record what was asked and what the control holds afterwards.

    // Partial facts for the common scanner: the committed value lives in the
    // wrapper, not the search input. The wrapper exposes requiredness and the
    // committed single/multi value even when its writer is unsupported; optional
    // selects are not supplemented. Labels and required markers stay common.
    const facts = (node) =>
      isControl(node)
        ? {
            type: "combobox",
            value: value(node),
            supported: supported(node),
            options: cachedOptions(node),
            educationIndex: educationIndex(node),
            multiple: multiple(node),
            readable: ["true", "false"].includes(
              node.getAttribute("aria-required"),
            ),
            optionalSupplement: false,
          }
        : null;
    // The only public component transaction. Selection belongs to the caller;
    // this component exposes page facts, commits the selection and reads it back.
    async function chooseFrom(node, pick, options = {}) {
      if (multiple(node)) {
        const available = await readOptions(node, options.canProceed, {
          answer: options.query,
          optionSpec: options.optionSpec,
        });
        const selected = pick(available.map((item) => item.label));
        if (selected == null) return null;
        const answers = options.append
          ? [...new Set([...value(node), ...[selected].flat()])]
          : [selected].flat();
        return chooseMultipleUntraced(node, answers, { ...options, available });
      }
      return chooseOptions(node, pick, options);
    }
    JobsGreenhouseControls = Object.freeze({
      facts,
      isControl,
      multiple,
      value,
      chooseFrom,
      readOptions,
      cachedOptions,
    });
  })();
}
