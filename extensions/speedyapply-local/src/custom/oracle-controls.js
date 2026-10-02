import { JobsPageActions } from "./page-actions.js";
import { JobsDOMWait } from "./dom-wait.js";
import { JobsControlFields } from "./control-fields.js";

export var JobsOracleControls;
let initialized = false;
export function initializeOracleControls() {
  if (initialized) return;
  initialized = true;
  // Oracle Recruiting Candidate Experience cx-select grids. One writer is used
  // by the adapter, saved answers, AI supplementation and remote gap repairs.
  (() => {
    const text = (value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const normal = (value) => text(value).normalize("NFKC").toLowerCase();
    const records = new WeakMap();
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const isControl = (node) =>
      !!node?.matches?.('input.cx-select-input[role="combobox"]') &&
      /\.oraclecloud\.com$/.test(node.ownerDocument.location.hostname);
    const owner = (node) => node.closest(".input-row");
    const list = (node) =>
      node.ownerDocument.getElementById(node.getAttribute("aria-controls"));
    const datePart = (node) => /^(month|year)-/.test(node.id);
    // Remote searches: their list is filled by typing a term.
    const remote = (node) =>
      ["educationalEstablishment", "city", "postalCode"].includes(node.name);
    function committedText(node, label) {
      return node.closest(".geo-hierarchy-form-element") &&
        ["city", "postalCode"].includes(node.name)
        ? text(label).split(",")[0].trim()
        : text(label);
    }
    function record(node) {
      if (!records.has(node)) {
        const entry = { dirty: false, options: undefined };
        records.set(node, entry);
        node.addEventListener("input", () => {
          entry.dirty = true;
          entry.options = undefined;
        });
        node.addEventListener("change", () => {
          if (!node.value) entry.dirty = false;
        });
        // User selection and adapter selection must commit the same state.
        node.ownerDocument.addEventListener(
          "click",
          (event) => {
            const cell = event.target.closest?.('[role="gridcell"]');
            if (!cell || !list(node)?.contains(cell)) return;
            const selected = committedText(node, cell.textContent);
            setTimeout(() => {
              if (
                node.isConnected &&
                normal(node.value) === normal(selected) &&
                node.getAttribute("aria-expanded") !== "true"
              ) {
                entry.dirty = false;
                entry.committedValue = selected;
                entry.options = [{ value: selected, label: selected }];
              }
            }, 100);
          },
          true,
        );
      }
      return records.get(node);
    }
    function find(root) {
      return [
        ...root.querySelectorAll('input.cx-select-input[role="combobox"]'),
      ].filter(isControl);
    }
    function options(node) {
      return [...(list(node)?.querySelectorAll('[role="gridcell"]') || [])]
        .filter((e) => e.getAttribute("aria-disabled") !== "true")
        .map((e) => ({
          node: e,
          value: text(e.textContent),
          label: text(e.textContent),
        }))
        .filter((e) => e.label);
    }
    function value(node) {
      const state = record(node);
      if (
        node.matches(".cx-select-input--auto-suggest") &&
        node.getAttribute("aria-invalid") !== "true" &&
        owner(node)?.classList.contains("input-row--filled")
      )
        return text(node.value);
      const selected = options(node).find(
        (option) =>
          option.node.getAttribute("aria-selected") === "true" &&
          normal(committedText(node, option.label)) === normal(node.value),
      );
      if (selected) {
        state.dirty = false;
        state.committedValue = committedText(node, selected.label);
      }
      if (state.dirty) return "";
      // Oracle's filled class belongs to the model, unlike temporary search text.
      return owner(node)?.classList.contains("input-row--filled") ||
        (datePart(node) &&
          normal(state.committedValue) &&
          normal(state.committedValue) === normal(node.value))
        ? text(node.value)
        : "";
    }
    function describe(node) {
      const box = owner(node),
        label = box?.querySelector(".input-row__label");
      let question = text(
        label?.textContent || node.getAttribute("aria-label"),
      );
      const part = node.id.match(/^(month|year)-/i)?.[1];
      if (part) question += " " + part;
      if (node.id.startsWith("country-codes-")) question = "Phone country code";
      const region = node.closest('[role="region"]');
      const answerContext =
        node.closest(".geo-hierarchy-form-element") &&
        ["city", "postalCode"].includes(node.name)
          ? {
              geography: {
                kind: node.name,
                state: region?.querySelector('[name="region2"]')?.value || "",
                city: region?.querySelector('[name="city"]')?.value || "",
              },
            }
          : undefined;
      return {
        answerContext,
        type: "combobox",
        question,
        value: value(node),
        group: [node],
        required:
          node.getAttribute("aria-required") === "true" ||
          !!label?.classList.contains("input-row__label--required"),
        requiredKnown: !!box || node.hasAttribute("aria-required"),
        invalid:
          node.getAttribute("aria-invalid") === "true" ||
          !!box?.classList.contains("input-row--invalid"),
        supported: !node.disabled && !node.readOnly,
        readable: true,
        options: record(node).options,
        component: "oracle-grid",
        ...(record(node).dirty && text(node.value) && !value(node)
          ? { commitState: "unconfirmed" }
          : {}),
      };
    }
    async function open(node, canProceed) {
      canProceed = JobsPageActions.guard(canProceed);
      if (
        !JobsPageActions.live(canProceed) ||
        !node.isConnected ||
        node.disabled ||
        node.readOnly
      )
        return false;
      record(node);
      if (node.getAttribute("aria-expanded") !== "true") {
        node.focus();
        JobsPageActions.click(node);
      }
      return !!(await JobsDOMWait.until(
        () =>
          JobsPageActions.live(canProceed) &&
          node.isConnected &&
          node.getAttribute("aria-expanded") === "true" &&
          list(node) &&
          list(node).getAttribute("aria-busy") !== "true",
        { root: node.ownerDocument, timeout: 5000 },
      ));
    }
    // Oracle debounces remote searches by 500 ms. Do not accept the old list
    // during that interval or confuse its temporary text with a selection.
    async function search(node, term, canProceed, found) {
      if (
        !(await JobsControlFields.writeText(node, text(term), {
          canProceed,
          blur: false,
        }))
      )
        return false;
      await pause(600);
      return !!(await JobsDOMWait.until(
        () =>
          JobsPageActions.live(canProceed) &&
          list(node)?.getAttribute("aria-busy") !== "true" &&
          found(),
        { root: node.ownerDocument, timeout: 5000 },
      ));
    }
    // A remote search reads the results of its term; the search text is cleared afterwards.
    async function readOptions(
      node,
      canProceed = /** @type {() => boolean} */ (() => true),
      { answer } = /** @type {{answer?: string}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (!(await open(node, canProceed))) return [];
      const labels = () =>
        options(node).map(({ value, label }) => ({ value, label }));
      if (
        remote(node) &&
        !node.matches(".cx-select-input--auto-suggest") &&
        !options(node).length &&
        text(answer)
      ) {
        try {
          await search(
            node,
            answer,
            canProceed,
            () => options(node).length > 0,
          );
        } finally {
          if (
            JobsPageActions.live(canProceed) &&
            node.value &&
            !record(node).committedValue
          )
            await JobsControlFields.writeText(node, "", {
              canProceed,
              blur: false,
            });
        }
      }
      return (record(node).options = labels());
    }
    // Click the chosen option and verify the field committed it. Oracle marks
    // a date row filled only after BOTH parts are selected, so each part's click
    // is verified on its own.
    async function commit(node, chosen, canProceed) {
      if (
        !JobsPageActions.live(canProceed) ||
        !node.isConnected ||
        !JobsPageActions.click(chosen.node)
      )
        return false;
      // The click is processed (the list closes or the value changes) before the field loses focus.
      await JobsDOMWait.until(
        () =>
          !JobsPageActions.live(canProceed) ||
          node.getAttribute("aria-expanded") !== "true" ||
          normal(node.value) === normal(committedText(node, chosen.label)),
        { root: node.ownerDocument, timeout: 1000 },
      );
      node.blur();
      const committed = await JobsDOMWait.until(
        () =>
          JobsPageActions.live(canProceed) &&
          node.isConnected &&
          node.getAttribute("aria-expanded") !== "true" &&
          normal(node.value) === normal(committedText(node, chosen.label)) &&
          node.getAttribute("aria-invalid") !== "true" &&
          (datePart(node) ||
            owner(node)?.classList.contains("input-row--filled")),
        { root: node.ownerDocument, timeout: 3000 },
      );
      if (committed) {
        record(node).dirty = false;
        record(node).committedValue = committedText(node, chosen.label);
        record(node).options = [{ value: chosen.value, label: chosen.label }];
      }
      return !!committed;
    }
    // One transaction: open once; a remote search with nothing the rule accepts
    // types its term once. The rule picks among the listed options and that
    // option is clicked in the same open list.
    async function chooseOptions(
      node,
      pickLabel,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        query,
      } = /** @type {{canProceed?: () => boolean, query?: string}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (typeof pickLabel !== "function") return null;
      if (node.matches(".cx-select-input--auto-suggest")) {
        const label = pickLabel([text(query)]);
        if (!label) return null;
        const result = await JobsControlFields.writeText(node, label, {
          canProceed,
        });
        if (result && value(node)) {
          record(node).dirty = false;
          return node;
        }
        return null;
      }
      if (!(await open(node, canProceed))) return null;
      const pickFrom = () => {
        const found = options(node),
          label = found.length
            ? pickLabel(found.map((option) => option.label))
            : null,
          same = label ? found.filter((option) => option.label === label) : [];
        return same.length === 1 ? same[0] : null;
      };
      let chosen = pickFrom();
      if (!chosen && remote(node) && text(query)) {
        await search(node, query, canProceed, () => options(node).length > 0);
        chosen = pickFrom();
        if (!chosen) {
          if (
            JobsPageActions.live(canProceed) &&
            node.value &&
            !record(node).committedValue
          )
            await JobsControlFields.writeText(node, "", {
              canProceed,
              blur: false,
            });
          return null;
        }
      }
      if (!chosen) {
        node.blur();
        return null;
      }
      return (await commit(node, chosen, canProceed)) ? node : null;
    }
    function metadata(node) {
      if (!/\.oraclecloud\.com$/.test(node.ownerDocument.location.hostname))
        return null;
      const box = owner(node),
        label = box?.querySelector(".input-row__label");
      if (!box) return null;
      return {
        question: text(label?.textContent),
        required: !!label?.classList.contains("input-row__label--required"),
        invalid: box.classList.contains("input-row--invalid"),
        signature:
          node.getAttribute("name") === "fullName" &&
          !!node.closest('[role="region"][aria-label*="Signature"]'),
      };
    }
    // The only public component transaction. Selection belongs to the caller;
    // this component exposes page facts, commits the selection and reads it back.
    async function chooseFrom(node, pick, options = {}) {
      return chooseOptions(node, pick, options);
    }
    JobsOracleControls = {
      isControl,
      find,
      describe,
      value,
      readOptions,
      cachedOptions: (node) => record(node).options,
      chooseFrom,
      metadata,
    };
  })();
}
