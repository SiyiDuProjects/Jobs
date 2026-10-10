import { stableStringify } from "./stable-value.js";
import { JobsPlatformConfig } from "./platform-config.js";
import { JobsControlFields } from "./control-fields.js";
import { JobsPageActions } from "./page-actions.js";
import { JobsDOMWait } from "./dom-wait.js";
import { JobsOptionMatch } from "./option-match.js";
import { JobsDiagnostics } from "./diagnostics.js";
export var JobsWorkdayControls;
let initialized = false;
export function initializeWorkdayControls() {
  if (initialized) return;
  initialized = true;
  // Workday's linked listbox and search-prompt components. Page adapters supply
  // profile values/aliases; every caller uses these same readers and writers.
  (() => {
    const text = (value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const norm = (value) => text(value).toLowerCase();
    const cache = new WeakMap(),
      expectedSelections = new WeakMap();
    const namedDropdowns = new WeakSet();
    const extraAttempts = new WeakMap(),
      languageDropdowns = new WeakSet(),
      checkboxGroups = new Set();
    const visible = (node) =>
      !!node && JobsControlFields.create(node.ownerDocument).visible(node);
    const field = (node) => node.closest('[data-automation-id^="formField-"]');
    const isPrompt = (node) =>
      !!node?.matches('input[data-uxi-widget-type="selectinput"]') &&
      !!node.closest('[data-automation-id="multiSelectContainer"]');
    const isPaste = (node) =>
      !!node?.matches?.(
        'input[data-automation-id="company"],input[name="companyName"]',
      ) && !isPrompt(node);
    const isDropdown = (node) =>
      !!node &&
      (namedDropdowns.has(node) ||
        node.matches('button[aria-haspopup="listbox"]'));
    const isControl = (node) =>
      !!node &&
      /\.(myworkdayjobs|myworkdaysite)\.com$/.test(
        node.ownerDocument.location.hostname,
      ) &&
      (isPrompt(node) ||
        isDropdown(node) ||
        isMonth(node) ||
        isCheckboxGroup(node) ||
        isPaste(node));
    const container = (node) =>
      node.closest('[data-automation-id="multiSelectContainer"]');
    const value = (node) =>
      isPaste(node)
        ? node.value
        : isMonth(node)
          ? readMonth(node)
          : isCheckboxGroup(node)
            ? readCheckboxGroup(node)
            : isPrompt(node)
              ? [
                  ...container(node).querySelectorAll(
                    '[data-automation-id="selectedItemList"] [data-automation-id="selectedItem"],li[data-automation-id="menuItem"]',
                  ),
                ]
                  .filter(
                    (item) =>
                      !item.querySelector(
                        '[data-automation-id="selectedItem"]',
                      ),
                  )
                  .filter(visible)
                  .map((item) =>
                    text(
                      item.querySelector(
                        '[data-automation-id="promptOption"],p',
                      )?.textContent || item.textContent,
                    ),
                  )
                  .filter(Boolean)
              : /^(select one|select|choose)(?:\s*[.…]*)?$/i.test(
                    text(node.textContent),
                  )
                ? ""
                : text(node.textContent);
    const title = (node) =>
      text(
        field(node)?.querySelector('[data-automation-id="richText"],label')
          ?.textContent ||
          node.getAttribute("aria-label") ||
          node.getAttribute("aria-labelledby"),
      );
    const cachedOptions = (node) =>
      cache.get(node)?.title === title(node)
        ? cache.get(node).options
        : undefined;
    const press = (node, key) => {
      for (const type of key === "Enter"
        ? ["keydown", "keypress", "keyup"]
        : ["keydown", "keyup"])
        JobsPageActions.dispatch(
          node,
          new node.ownerDocument.defaultView.KeyboardEvent(type, {
            key,
            code: key,
            keyCode: key === "Enter" ? 13 : 27,
            which: key === "Enter" ? 13 : 27,
            bubbles: true,
            cancelable: true,
          }),
        );
    };
    function popupHosts(node) {
      if (!isPrompt(node)) {
        const popup = node.ownerDocument.getElementById(
          node.getAttribute("aria-controls"),
        );
        return popup && visible(popup) ? [popup] : [];
      }
      const id = node.getAttribute("data-uxi-multiselect-id");
      if (!id) return [];
      return [
        ...node.ownerDocument.querySelectorAll(
          "[data-uxi-popup-anchor],[data-associated-widget]",
        ),
      ].filter(
        (root) =>
          (root.getAttribute("data-uxi-popup-anchor") === id ||
            root.getAttribute("data-associated-widget") === id) &&
          visible(root),
      );
    }
    function roots(node) {
      return popupHosts(node).flatMap((host) => {
        if (
          host.matches('[aria-busy="true"]') ||
          host.querySelector('[aria-busy="true"]')
        )
          return [];
        // The responsive shell mounts before its active list. Keep the original
        // Workday readiness boundary: the shell cannot yet receive Enter.
        if (isPrompt(node) && host.hasAttribute("data-associated-widget"))
          return [
            ...host.querySelectorAll(
              '[data-automation-id="activeListContainer"] [role="presentation"]',
            ),
          ].filter(visible);
        return [host];
      });
    }
    const loading = (node) =>
      popupHosts(node).some(
        (host) =>
          host.matches('[aria-busy="true"]') ||
          host.querySelector('[aria-busy="true"]'),
      );
    function options(node, { search = false } = {}) {
      return [
        ...new Set(
          roots(node).flatMap((root) => [
            ...root.querySelectorAll('[role="option"]'),
          ]),
        ),
      ]
        .filter(
          (option) =>
            visible(option) &&
            option.id !== "select-one" &&
            option.getAttribute("aria-disabled") !== "true" &&
            (!search ||
              option
                .closest("[data-uxi-multiselectlist-issearch]")
                ?.getAttribute("data-uxi-multiselectlist-issearch") !==
                "false") &&
            !option.querySelector("input:disabled"),
        )
        .map((option) => ({
          node: option,
          target:
            option.querySelector(
              'input[type="checkbox"],input[type="radio"]',
            ) || option,
          label: text(
            option.querySelector('[data-automation-id="promptOption"]')
              ?.textContent || option.textContent,
          ),
          searchMode:
            option
              .closest("[data-uxi-multiselectlist-issearch]")
              ?.getAttribute("data-uxi-multiselectlist-issearch") ?? null,
        }))
        .filter((option) => option.label);
    }
    function guard(node, canProceed) {
      canProceed = JobsPageActions.guard(canProceed);
      const url = node.ownerDocument.location.href;
      return () =>
        JobsPageActions.live(canProceed) &&
        visible(node) &&
        node.ownerDocument.location.href === url &&
        !node.disabled &&
        !node.readOnly;
    }
    const wait = (read, node, timeout = 2500) =>
      JobsDOMWait.until(read, { root: node.ownerDocument, timeout });
    // Keep observing the SAME pending operation while a hidden page is slow.
    // A foreground/resume event gets one fresh response window, without Enter
    // or a selection click being replayed. Every extension is bounded.
    async function promptWait(read, node, current, timeout = 2500) {
      const doc = node.ownerDocument;
      let wasHidden = doc.hidden;
      const visibility = () => {
        wasHidden ||= doc.hidden;
      };
      doc.addEventListener("visibilitychange", visibility);
      const readCurrent = () => (!current() ? [] : read());
      let result;
      try {
        result = await wait(readCurrent, node, timeout);
      } finally {
        doc.removeEventListener("visibilitychange", visibility);
      }
      if (result || !current()) return result;
      if (!doc.hidden)
        return wasHidden ? wait(readCurrent, node, timeout) : result;
      JobsDiagnostics?.note(
        "auto_prompt_background_wait",
        node,
        "Pending response while hidden",
      );
      const resumed = {};
      result = await wait(
        () => readCurrent() || (!node.ownerDocument.hidden ? resumed : null),
        node,
        30000,
      );
      return result === resumed ? wait(readCurrent, node, timeout) : result;
    }
    const close = (node) => {
      if (popupHosts(node).length) press(node, "Escape");
    };
    async function open(node, current, activate = true) {
      if (!current()) return false;
      if (activate && !popupHosts(node).length) JobsPageActions.click(node);
      return (
        !!(await promptWait(
          () =>
            !current() ? { cancelled: true } : roots(node).length ? true : null,
          node,
          current,
        )) && current()
      );
    }
    function matchingOptions(
      found,
      answer,
      {
        optionSpec,
      } = /** @type {{optionSpec?:import('./control-types.js').ControlAnswerSpec}} */ ({}),
    ) {
      if (optionSpec) {
        const picked = JobsOptionMatch.pick(
          found.map((option) => option.label),
          optionSpec,
        );
        return picked ? [found[picked.index]] : [];
      }
      return found.filter((option) => norm(option.label) === norm(answer));
    }
    async function search(node, answer, current, policy = {}) {
      if (!current()) return [];
      const note = (type, detail) => JobsDiagnostics?.note(type, node, detail);
      if (!popupHosts(node).length) JobsPageActions.click(node);
      // The search is a native input write without key events or blur, then one
      // explicit Enter after the list is ready.
      const written = await JobsControlFields.writeText(node, answer, {
        blur: false,
        waitForRender: false,
        canProceed: current,
      });
      note("auto_prompt_wait", "Waiting for active list");
      if (!(await open(node, current, false))) {
        note("auto_prompt_failed", "Active list unavailable");
        return [];
      }
      // Responsive prompts may reset their controlled search value when the
      // initial list mounts. Enter must use the value accepted AFTER that mount.
      // Keep the input-first path for variants that mount only after typing.
      if (!written || node.value !== String(answer)) {
        note(
          "auto_prompt_input_retry",
          "Search value reset while the active list mounted",
        );
        if (
          !(await JobsControlFields.writeText(node, answer, {
            blur: false,
            waitForRender: false,
            canProceed: current,
          }))
        ) {
          note(
            "auto_prompt_failed",
            "Search input did not retain the requested value",
          );
          return [];
        }
      }
      const before = options(node),
        beforeRoots = roots(node);
      note("auto_prompt_search", "Enter");
      press(node, "Enter");
      // A matching option left over from the previous search is not a response.
      // Preserve the old wait for list replacement, also accepting an in-place
      // response whose options/search mode change. A list without search-mode
      // markers is read as it stands.
      let responseLoading = false;
      const response = await promptWait(
        () => {
          if (!current()) return [];
          if (value(node).some((label) => norm(label) === norm(answer)))
            return [];
          if (loading(node)) {
            responseLoading = true;
            return null;
          }
          const found = options(node, { search: true });
          const fresh =
            responseLoading ||
            roots(node).some((root) => !beforeRoots.includes(root)) ||
            found.some(
              (option) =>
                !before.some(
                  (old) =>
                    old.node === option.node &&
                    old.label === option.label &&
                    old.searchMode === option.searchMode,
                ),
            );
          const unmarked = before.every((option) => option.searchMode === null);
          if (!(fresh || unmarked)) return null;
          // An unrelated unchanged window cannot conclude the new search.
          if (
            !fresh &&
            !matchingOptions(found, policy.target ?? answer, policy).length
          )
            return null;
          const empty =
            fresh &&
            roots(node).some((root) =>
              /\bno (?:items|results)\b/i.test(root.textContent),
            );
          return found.length || empty ? found : null;
        },
        node,
        current,
      );
      if (!response || !current()) {
        note(
          "auto_prompt_failed",
          "Search response unavailable before deadline",
        );
        return [];
      }
      note("auto_prompt_results", "Current search response observed");
      if (!response.length) return response;
      // Each virtual window is a separate page response. Charging all windows
      // to the initial search deadline loses valid late candidates, especially
      // while the site's rendering is delayed in a background tab.
      let found = response;
      const observed = new Map();
      for (let step = 0; current() && step <= 20; step++) {
        for (const option of found) observed.set(option.label, option);
        const lists = popupHosts(node).flatMap((host) => [
          ...(host.matches('[data-automation-id="activeListContainer"]')
            ? [host]
            : []),
          ...host.querySelectorAll(
            '[data-automation-id="activeListContainer"]',
          ),
        ]);
        const list = lists.find(
          (item) =>
            visible(item) &&
            item.clientHeight > 0 &&
            item.scrollHeight > item.clientHeight,
        );
        // A reused list can retain the previous query's scroll position.
        const rewind = step === 0 && list?.scrollTop > 0;
        if (matchingOptions(found, policy.target ?? answer, policy).length)
          return found;
        if (
          !list ||
          step === 20 ||
          (!rewind &&
            list.scrollTop + list.clientHeight >= list.scrollHeight - 1)
        )
          break;
        const previous = found;
        list.scrollTop = rewind
          ? 0
          : Math.min(
              list.scrollHeight - list.clientHeight,
              list.scrollTop + Math.max(1, list.clientHeight * 0.8),
            );
        JobsPageActions.dispatch(
          list,
          new node.ownerDocument.defaultView.Event("scroll", { bubbles: true }),
        );
        note(
          "auto_prompt_scroll",
          rewind
            ? "Reset new search to first window"
            : "Searching the next rendered result window",
        );
        const next = await promptWait(
          () => {
            if (loading(node)) return null;
            const items = options(node, { search: true });
            return items.some(
              (option, index) =>
                option.node !== previous[index]?.node ||
                option.label !== previous[index]?.label,
            )
              ? items
              : null;
          },
          node,
          current,
        );
        if (!next || !current()) {
          note(
            "auto_prompt_failed",
            "Virtual result window unavailable before deadline",
          );
          break;
        }
        found = next;
      }
      // Return inspected unmatched candidates to the shared rule/trace. Empty
      // arrays previously mislabeled an actual catalog mismatch as no-options.
      // Detached candidates remain evidence only: chooseOptions checks liveness.
      return current() ? [...observed.values()] : [];
    }
    // The education entry a field belongs to (its numbered section): page
    // structure the rule layer uses to pick that entry's facts.
    function educationIndex(node) {
      const group = node.closest(
        '[data-automation-id^="education-"],[aria-labelledby*="-panel"]',
      );
      const name =
        group?.getAttribute("data-automation-id") ||
        group?.getAttribute("aria-labelledby") ||
        "";
      if (!/^education-\d+$/.test(name) && !/education/i.test(name))
        return undefined;
      const number = Number(name.match(/(\d+)(?:-panel)?$/)?.[1]);
      return number >= 1 ? number - 1 : undefined;
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
      if (!isControl(node)) return [];
      if (isMonth(node) || isPaste(node)) return [];
      if (isCheckboxGroup(node))
        return checkboxItems(node).map((item) => ({
          value: item.label,
          label: item.label,
        }));
      const current = guard(node, canProceed);
      let query = "";
      try {
        let found;
        if (isPrompt(node)) {
          // Searching can itself commit a site's default. Establish the semantic
          // expectation before Enter, including when no candidate is returned.
          if (optionSpec && !optionSpec.append)
            expectedSelections.set(node, {
              spec: optionSpec,
              url: node.ownerDocument.location.href,
            });
          query = text(answer);
          found = query
            ? await search(node, query, current, { optionSpec })
            : (await open(node, current))
              ? options(node)
              : [];
        } else
          found = (await open(node, current))
            ? await wait(
                () =>
                  !current() ? [] : options(node).length ? options(node) : null,
                node,
              )
            : [];
        if (!current()) return [];
        const labels = [
          ...new Set((found || []).map((option) => option.label)),
        ];
        const result = labels
          .slice(0, 150)
          .map((label) => ({ value: label, label }));
        cache.set(node, { title: title(node), options: result });
        return result;
      } finally {
        if (current()) {
          close(node);
          if (query && node.value === query)
            await JobsControlFields.writeText(node, "", {
              blur: false,
              waitForRender: false,
              canProceed: current,
            });
        }
      }
    }
    async function chooseUntraced(
      node,
      answer,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
        append = false,
        query,
        kind,
      } = /** @type {{canProceed?: () => boolean, replace?: boolean, append?: boolean, query?: string, kind?: string}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (isPaste(node)) {
        if (
          !JobsPageActions.live(canProceed) ||
          !visible(node) ||
          node.disabled ||
          node.readOnly ||
          typeof answer !== "string" ||
          (value(node) && !replace)
        )
          return null;
        const written = await pasteValue(node, answer, true, canProceed);
        return written &&
          JobsPageActions.live(canProceed) &&
          node.isConnected &&
          value(node) === answer &&
          !describe(node).invalid
          ? node
          : null;
      }
      if (isMonth(node))
        return writeMonthParts(node, answer, { canProceed, replace });
      return null;
    }
    // One operation for the shared semantic entrance: search (or open) once,
    // let the caller's rule pick among the current results, commit that option.
    // A search prompt is never searched a second time to commit.
    async function chooseOptions(
      node,
      pickLabel,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
        append = false,
        query,
        optionSpec,
        search: policy,
      } = /** @type {{canProceed?: () => boolean, replace?: boolean, append?: boolean, query?: string, optionSpec?: import('./control-types.js').ControlAnswerSpec, search?: {target?: string,optionSpec?: import('./control-types.js').ControlAnswerSpec}}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (!isControl(node) || isMonth(node) || isPaste(node)) return null;
      if (isCheckboxGroup(node)) {
        const label = pickLabel(checkboxItems(node).map((item) => item.label));
        return label
          ? selectCheckboxLabel(node, label, { canProceed, replace })
          : null;
      }
      const current = guard(node, canProceed),
        previous = value(node),
        prompt = isPrompt(node);
      if ((prompt ? previous.length : previous) && !replace && !append)
        return null;
      // Replacing one of several pills needs a separately identified remove control.
      if (prompt && previous.length && replace && !append) return null;
      const typed = query;
      try {
        // Searching can itself commit a site's default. Establish the semantic
        // expectation before Enter, including when no candidate is returned.
        if (prompt && optionSpec && !optionSpec.append)
          expectedSelections.set(node, {
            spec: optionSpec,
            url: node.ownerDocument.location.href,
          });
        const found =
          (prompt
            ? typed
              ? await search(node, typed, current, policy ?? { optionSpec })
              : (await open(node, current))
                ? options(node)
                : []
            : (await open(node, current))
              ? await wait(
                  () =>
                    !current()
                      ? []
                      : options(node).length
                        ? options(node)
                        : null,
                  node,
                )
              : []) || [];
        if (!current()) return null;
        // Some prompts commit the searched value on Enter; the rule then judges
        // the new pill instead of an option list.
        const pills =
          prompt && !found.length
            ? value(node).filter((item) => !previous.includes(item))
            : [];
        if (pills.length) {
          const picked = pickLabel(
            pills,
            pills.map((item) => ({ label: item })),
          );
          return picked ? node : null;
        }
        const labels = [...new Set(found.map((option) => option.label))];
        cache.set(node, {
          title: title(node),
          options: labels
            .slice(0, 150)
            .map((label) => ({ value: label, label })),
        });
        const label = pickLabel(labels, found);
        if (!label) return null;
        if (prompt && value(node).some((item) => norm(item) === norm(label)))
          return node;
        const selected = found.find((option) => option.label === label);
        if (!selected || !selected.target.isConnected) return null;
        // Virtual lists can reuse a still-connected option for another label.
        // Previously inspected windows are evidence, not permission to click
        // a recycled row that now represents a different choice.
        if (
          !options(node).some(
            (option) =>
              option.target === selected.target && option.label === label,
          )
        )
          return null;
        if (prompt && !append)
          container(node).setAttribute("data-jobs-expected-choice", label);
        if (!selected.target.checked) JobsPageActions.click(selected.target);
        const readAccepted = () => {
          if (!current()) return { cancelled: true };
          const actual = value(node);
          return (
            (prompt
              ? actual.some((item) => norm(item) === norm(label))
              : norm(actual) === norm(label)) &&
            node.getAttribute("aria-invalid") !== "true"
          );
        };
        const accepted = await (prompt
          ? promptWait(readAccepted, node, current, 1500)
          : wait(readAccepted, node, 1500));
        if (languageDropdowns.has(node) && accepted !== true)
          extraAttempts.set(node, {
            expected: text(label),
            url: node.ownerDocument.location.href,
          });
        if (prompt)
          JobsDiagnostics?.note(
            accepted === true ? "auto_prompt_committed" : "auto_prompt_failed",
            node,
            accepted === true
              ? "Selected pill verified"
              : "Selection was not committed",
          );
        return accepted === true && current()
          ? prompt
            ? selected.target
            : node
          : null;
      } finally {
        if (current()) {
          close(node);
          if (prompt && typed && node.value === typed)
            await JobsControlFields.writeText(node, "", {
              blur: false,
              waitForRender: false,
              canProceed: current,
            });
        }
      }
    }
    function monthParts(node) {
      if (
        !node?.matches?.(
          '[data-automation-id="dateInputWrapper"],[data-automation-id="formField-startDate"],[data-automation-id="formField-endDate"]',
        )
      )
        return null;
      // The original month writer targets Start/End employment or education
      // fields. A full calendar briefly missing its Day input is not a month picker.
      if (
        !node.closest(
          '[data-automation-id="formField-startDate"],[data-automation-id="formField-endDate"]',
        )
      )
        return null;
      if (
        node.matches('[data-automation-id^="formField-"]') &&
        node.querySelector('[data-automation-id="dateInputWrapper"]')
      )
        return null;
      const year = [
          ...node.querySelectorAll(
            'input[data-automation-id="dateSectionYear-input"]',
          ),
        ],
        month = [
          ...node.querySelectorAll(
            'input[data-automation-id="dateSectionMonth-input"]',
          ),
        ];
      return year.length === 1 &&
        month.length === 1 &&
        !node.querySelector('input[data-automation-id="dateSectionDay-input"]')
        ? { year: year[0], month: month[0] }
        : null;
    }
    const isMonth = (node) => !!monthParts(node);
    const parseMonth = (value) => {
      const match = text(value).match(/^(\d{4})-(\d{2})$/);
      return match && +match[1] > 0 && +match[2] >= 1 && +match[2] <= 12
        ? match
        : null;
    };
    function readMonth(node) {
      const parts = monthParts(node);
      if (!parts) return "";
      const year = text(parts.year.value),
        month = text(parts.month.value);
      if (!year && !month) return "";
      const normalized = `${year}-${month.padStart(2, "0")}`;
      return parseMonth(normalized)
        ? normalized
        : `${year || "____"}-${month || "__"}`;
    }
    function checkboxItems(node) {
      return [...node.querySelectorAll('[role="cell"]')]
        .map((cell) => ({
          input: cell.querySelector('input[type="checkbox"]'),
          labelNode: cell.querySelector("label"),
        }))
        .filter((item) => item.input && item.labelNode)
        .map((item) => ({ ...item, label: text(item.labelNode.textContent) }));
    }
    function isCheckboxGroup(node) {
      return (
        (!!node?.matches?.(
          '[data-automation-id="disability"],[data-automation-id="ethnicityPrompt"],[data-automation-id$="-CheckboxGroup"]',
        ) &&
          checkboxItems(node).length > 0) ||
        checkboxGroups.has(node)
      );
    }
    function checkboxTitle(node) {
      let current = node;
      while (current) {
        const legend = text(
          current.querySelector(":scope > legend")?.textContent,
        );
        if (legend) return legend;
        current = current.parentElement?.closest("fieldset");
      }
      return title(node);
    }
    const multiple = (node) =>
      isCheckboxGroup(node) &&
      !/\b(?:check|choose|select) (?:only |exactly )?one\b/i.test(
        checkboxTitle(node),
      );
    function readCheckboxGroup(node) {
      const labels = checkboxItems(node)
        .filter((item) => item.input.checked)
        .map((item) => item.label);
      return multiple(node) ? labels : labels.length === 1 ? labels[0] : "";
    }
    function find(scope) {
      if (
        !/\.(myworkdayjobs|myworkdaysite)\.com$/.test(
          (scope.ownerDocument || scope).location?.hostname || "",
        )
      )
        return [];
      const candidates = [
        scope,
        ...scope.querySelectorAll(
          '[data-automation-id="dateInputWrapper"],[data-automation-id="formField-startDate"],[data-automation-id="formField-endDate"],[data-automation-id="disability"],[data-automation-id="ethnicityPrompt"],[data-automation-id$="-CheckboxGroup"],input[data-automation-id="company"],input[name="companyName"]',
        ),
      ];
      for (const node of checkboxGroups) {
        if (!node.isConnected) checkboxGroups.delete(node);
        else if (node === scope || scope.contains(node)) candidates.push(node);
      }
      return [
        ...new Set(
          candidates.filter(
            (node) => isMonth(node) || isCheckboxGroup(node) || isPaste(node),
          ),
        ),
      ];
    }
    function describe(node) {
      const parts = monthParts(node),
        choice = isCheckboxGroup(node),
        language = languageDropdowns.has(node),
        paste = isPaste(node);
      if (!parts && !choice && !language && !paste) return null;
      const group = parts
        ? [node, parts.year, parts.month]
        : choice
          ? [
              node,
              ...checkboxItems(node).flatMap((item) => [
                item.input,
                item.labelNode,
              ]),
            ]
          : [node];
      const label = choice
        ? checkboxTitle(node)
        : title(node) ||
          (paste
            ? text(
                [...(node.labels || [])]
                  .map((label) => label.textContent)
                  .join(" "),
              )
            : parts
              ? /endDate/.test(field(node)?.getAttribute("data-automation-id"))
                ? "End month"
                : "Start month"
              : "");
      const raw = value(node),
        required =
          group.some(
            (item) =>
              item.required || item.getAttribute("aria-required") === "true",
          ) ||
          /\*\s*$/.test(label) ||
          /\bRequired\b/.test(node.getAttribute("aria-label") || "");
      const explicitOptional =
        group.some((item) => item.getAttribute("aria-required") === "false") ||
        /\boptional\b/i.test(label);
      const attempt = extraAttempts.get(node);
      if (
        attempt &&
        (attempt.url !== node.ownerDocument.location.href ||
          stableStringify(raw) === stableStringify(attempt.expected))
      )
        extraAttempts.delete(node);
      const isDisabled = (item) =>
        item.disabled || item.getAttribute("aria-disabled") === "true";
      // Exclusive groups disable the unselected peers after a choice. That
      // does not disable the question or erase its selected answer.
      const disabled = choice
        ? isDisabled(node) ||
          checkboxItems(node).every(({ input }) => isDisabled(input))
        : group.some(isDisabled);
      return {
        component: paste
          ? "workday-company-paste"
          : parts
            ? "workday-month"
            : choice
              ? "workday-checkbox-group"
              : "workday-listbox",
        type: paste
          ? "text"
          : parts
            ? "month"
            : choice
              ? multiple(node)
                ? "select-multiple"
                : "custom-radio"
              : "combobox",
        question: label,
        value: raw,
        group,
        required,
        // These groups expose their native checkbox required/aria-required state,
        // as the pre-migration scanner did. Absence of a required marker must not
        // turn an already selected native group into an unknown custom widget.
        requiredKnown:
          required || explicitOptional || language || paste || choice,
        disabled,
        invalid:
          !!(parts && (dateHasError(node) || (raw && !parseMonth(raw)))) ||
          group.some(
            (item) =>
              item.getAttribute("aria-invalid") === "true" ||
              (item.willValidate && !item.validity.valid),
          ),
        readable: true,
        supported:
          !disabled &&
          !!label &&
          (!parts || (!parts.year.readOnly && !parts.month.readOnly)) &&
          (!paste || !node.readOnly),
        writable:
          !disabled &&
          (!parts || (!parts.year.readOnly && !parts.month.readOnly)) &&
          (!paste || !node.readOnly),
        options: choice
          ? checkboxItems(node).map((item) => ({
              value: item.label,
              label: item.label,
            }))
          : cachedOptions(node),
        ...(extraAttempts.has(node) ? { commitState: "unconfirmed" } : {}),
      };
    }
    // Both month/year and full dates are one transaction. Numeric segments
    // normalize leading zeroes; the form saves only after the whole group exits.
    const numericDatePart = (actual, expected) =>
      /^\d+$/.test(actual) && Number(actual) === Number(expected);
    const dateHasError = (node) =>
      !!node.closest('[aria-invalid="true"]') ||
      [
        ...(field(node) || node).querySelectorAll(
          '[data-automation-id="inputAlert"],[data-automation-id="inputError"]',
        ),
      ].some((error) => visible(error) && text(error.textContent));
    async function writeDateSegments(node, group, values, current, accepted) {
      const doc = node.ownerDocument,
        view = doc.defaultView;
      let edited = false,
        writing = false;
      const live = () => !edited && current();
      const onEdit = () => {
        if (!writing) edited = true;
      };
      for (const part of group)
        for (const type of ["input", "change"])
          part.addEventListener(type, onEdit);
      try {
        for (let index = 0; index < group.length; index++) {
          if (!live()) return null;
          let pending;
          writing = true;
          try {
            pending = JobsControlFields.writeText(group[index], values[index], {
              canProceed: live,
              click: true,
              blur: false,
              matchesValue: numericDatePart,
            });
          } finally {
            writing = false;
          }
          if (!(await pending) || !live())
            throw Error("日期控件已变化或未接受输入，请检查该题。");
        }
        const complete = () =>
          live() &&
          group.every((part, index) =>
            numericDatePart(part.value, values[index]),
          );
        if (!complete()) return null;
        // Focus may be redirected to a sibling spinner. Exit the actual active
        // member, and fall back only if no group exit occurred after all writes.
        let exited = false;
        const onExit = (event) => {
          if (!node.contains(event.relatedTarget)) exited = true;
        };
        node.addEventListener("focusout", onExit);
        try {
          const active = doc.activeElement;
          if (node.contains(active) && complete())
            JobsPageActions.when(() =>
              /** @type {HTMLElement} */ (active).blur(),
            );
          if (!exited && complete()) {
            const last = group.at(-1),
              relatedTarget = node.contains(doc.activeElement)
                ? null
                : doc.activeElement;
            for (const type of ["blur", "focusout"])
              JobsPageActions.dispatch(
                last,
                new view.FocusEvent(type, {
                  bubbles: type === "focusout",
                  composed: true,
                  relatedTarget,
                }),
              );
          }
        } finally {
          node.removeEventListener("focusout", onExit);
        }
        if (!live()) return null;
        const result = await JobsDOMWait.until(
          () => (!live() ? { ok: false } : accepted() ? { ok: true } : null),
          { root: doc, timeout: 1500 },
        );
        return result?.ok ? node : null;
      } finally {
        for (const part of group)
          for (const type of ["input", "change"])
            part.removeEventListener(type, onEdit);
      }
    }
    async function writeMonthParts(
      node,
      answer,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
      } = {},
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      const parts = monthParts(node);
      if (!parts || !parseMonth(answer) || (value(node) && !replace))
        return null;
      const current = () =>
        JobsPageActions.live(canProceed) &&
        visible(node) &&
        monthParts(node)?.year === parts.year &&
        monthParts(node)?.month === parts.month &&
        [parts.month, parts.year].every(
          (part) =>
            visible(part) &&
            !part.disabled &&
            !part.readOnly &&
            part.getAttribute("aria-disabled") !== "true",
        );
      const [year, month] = answer.split("-");
      return writeDateSegments(
        node,
        [parts.month, parts.year],
        [month, year],
        current,
        () => value(node) === answer && !describe(node).invalid,
      );
    }
    function clickCheckbox(item, doc) {
      JobsPlatformConfig.structure.workday.modernFlow(doc)
        ? item.labelNode?.click()
        : JobsPageActions.click(item.input);
    }
    async function selectCheckboxLabel(
      node,
      answer,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
      } = {},
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (
        !isCheckboxGroup(node) ||
        !JobsPageActions.live(canProceed) ||
        !visible(node) ||
        typeof answer !== "string"
      )
        return null;
      const items = checkboxItems(node),
        matches = items.filter((item) => norm(item.label) === norm(answer));
      if (matches.length !== 1) return null;
      const item = matches[0];
      if (
        item.input.disabled ||
        item.input.getAttribute("aria-disabled") === "true"
      )
        return null;
      if (!replace && items.some((other) => other.input.checked))
        return item.input.checked ? node : null;
      if (!multiple(node))
        for (const other of items)
          if (other !== item && other.input.checked) {
            if (!replace || other.input.disabled) return null;
            clickCheckbox(other, node.ownerDocument);
          }
      if (!JobsPageActions.live(canProceed)) return null;
      if (!item.input.checked) clickCheckbox(item, node.ownerDocument);
      return JobsPageActions.live(canProceed) && item.input.checked
        ? node
        : null;
    }
    async function chooseMultipleUntraced(
      node,
      answers,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
      } = /** @type {{canProceed?: () => boolean, replace?: boolean}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (
        !multiple(node) ||
        !Array.isArray(answers) ||
        new Set(answers.map(norm)).size !== answers.length
      )
        return null;
      const items = checkboxItems(node),
        wanted = new Set(answers.map(norm));
      if (
        answers.some(
          (answer) =>
            items.filter((item) => norm(item.label) === norm(answer)).length !==
            1,
        )
      )
        return null;
      if (!replace && items.some((item) => item.input.checked))
        return items.every(
          (item) => item.input.checked === wanted.has(norm(item.label)),
        )
          ? node
          : null;
      for (const item of items) {
        if (
          !JobsPageActions.live(canProceed) ||
          !visible(node) ||
          !item.input.isConnected ||
          (item.input.disabled &&
            item.input.checked !== wanted.has(norm(item.label)))
        )
          return null;
        if (item.input.checked !== wanted.has(norm(item.label)))
          clickCheckbox(item, node.ownerDocument);
      }
      return JobsPageActions.live(canProceed) &&
        items.every(
          (item) => item.input.checked === wanted.has(norm(item.label)),
        )
        ? node
        : null;
    }
    async function pasteValue(
      node,
      answer,
      blurAfterWrite = true,
      canProceed = /** @type {() => boolean} */ (() => true),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (answer == null || !node || node.disabled || node.readOnly)
        return node;
      if (answer === "" && node.value !== "") return node;
      const view = node.ownerDocument.defaultView;
      // Retain paste notification, but await the shared input/focusout commit.
      // Synthetic blur alone misses React onBlur when focus is redirected.
      return JobsControlFields.writeText(node, answer, {
        blur: blurAfterWrite,
        click: true,
        canProceed,
        onWritten() {
          const event = new view.ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: new view.DataTransfer(),
          });
          event.clipboardData.setData("text/plain", String(answer));
          JobsPageActions.dispatch(node, event);
        },
      });
    }
    function dateParts(node) {
      if (!node?.matches?.('[data-automation-id="dateInputWrapper"]'))
        return null;
      const parts = ["Month", "Day", "Year"].map((part) => [
        ...node.querySelectorAll(
          `input[data-automation-id="dateSection${part}-input"]`,
        ),
      ]);
      return parts.every((part) => part.length === 1)
        ? parts.map((part) => part[0])
        : null;
    }
    function calendarDate(input) {
      return JobsControlFields.calendarDate(input);
    }
    async function chooseDate(
      node,
      answer,
      { canProceed = /** @type {() => boolean} */ (() => true) } = {},
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      const date = calendarDate(answer),
        group = dateParts(node);
      if (!date || !group)
        throw Error(
          "请输入完整、有效的日期（年、月、日），不能只提供月份或年份。",
        );
      const current = () =>
        JobsPageActions.live(canProceed) &&
        visible(node) &&
        group.every(
          (part, index) =>
            part === dateParts(node)?.[index] &&
            visible(part) &&
            !part.disabled &&
            !part.readOnly &&
            part.getAttribute("aria-disabled") !== "true",
        );
      const [year, month, day] = date.iso.split("-"),
        values = [month, day, year];
      const accepted = () =>
        current() &&
        calendarDate(`${group[0].value}/${group[1].value}/${group[2].value}`)
          ?.iso === date.iso &&
        !group.some(
          (part) =>
            part.getAttribute("aria-invalid") === "true" ||
            (part.willValidate && !part.validity.valid),
        ) &&
        !dateHasError(node);
      if (!(await writeDateSegments(node, group, values, current, accepted)))
        throw Error(
          current()
            ? "网页尚未接受完整日期，请检查该题。"
            : "日期控件已变化或未接受输入，请检查该题。",
        );
      return node;
    }
    // Every entrance (a binding, a known answer, AI, remote review)
    // ends here: record what was asked and what the control holds afterwards.

    // Older Workday buttons acquire aria-controls only after opening and lack
    // aria-haspopup. A reviewed page selector names them as a listbox.
    function listbox(node, { language = false } = {}) {
      if (node?.matches?.("button")) {
        namedDropdowns.add(node);
        node.setAttribute("data-jobs-component", "workday-listbox");
      }
      if (language && node) languageDropdowns.add(node);
      return node;
    }
    function expect(node, spec) {
      if (!isPrompt(node) || spec.append) return;
      expectedSelections.set(node, {
        spec,
        url: node.ownerDocument.location.href,
      });
      if (spec.topic === "field-of-study")
        container(node).setAttribute(
          "data-jobs-expected-choice",
          spec.answer || spec.tiers[0][0],
        );
    }
    function selectionExpectation(node) {
      const expected = expectedSelections.get(node);
      return expected?.url === node.ownerDocument.location.href
        ? expected.spec
        : null;
    }
    function selectionValid(node) {
      const expected = selectionExpectation(node);
      if (!expected) return true;
      const values = value(node);
      return (
        values.length === 1 &&
        (expected.preferenceOnly === true ||
          !!JobsOptionMatch.pick(values, expected))
      );
    }
    // Partial facts for the common scanner: listbox buttons and search prompts.
    // The other Workday kinds own a full describe.
    const promptValue = (node) =>
      /^(?:select one|select|choose)(?:\s*[.…]*)?$/i.test(
        text(node.textContent),
      )
        ? ""
        : text(node.textContent);
    function facts(node, ctx) {
      if (isPrompt(node)) {
        // Workday clears the search input once a value becomes a selected pill.
        // Search text is never evidence of a committed selection.
        const selected = value(node) || [],
          expected = selectionExpectation(node)?.preferenceOnly
            ? null
            : node
                .closest('[data-automation-id="multiSelectContainer"]')
                ?.getAttribute("data-jobs-expected-choice");
        // An expectation judges a committed selection; an empty prompt is only unanswered
        // (an optional major whose search found nothing must not block the step).
        const wrong =
          [selected].flat().length > 0 &&
          ((expected &&
            (!Array.isArray(selected) ||
              selected.length !== 1 ||
              text(selected[0]).toLowerCase() !==
                text(expected).toLowerCase())) ||
            selectionValid(node) === false);
        return {
          type: "search-choice",
          value: selected,
          supported: true,
          readable: true,
          options: cachedOptions(node),
          invalid: !!wrong,
          educationIndex: educationIndex(node),
        };
      }
      if (!isDropdown(node)) return null;
      return {
        type: "combobox",
        value: promptValue(node),
        supported: true,
        options: cachedOptions(node),
        required: /\bRequired\b/i.test(node.getAttribute("aria-label") || ""),
        question: text(
          node
            .closest('[data-automation-id^="formField-"]')
            ?.querySelector('[data-automation-id="richText"]')?.textContent ||
            ctx.labelled(node),
        ).slice(0, 2000),
      };
    }
    // The only public component transaction. Selection belongs to the caller;
    // this component exposes page facts, commits the selection and reads it back.
    async function chooseFrom(node, pick, options = {}) {
      if (dateParts(node)) return chooseDate(node, pick([]), options);
      if (isMonth(node) || isPaste(node))
        return chooseUntraced(node, pick([]), options);
      if (multiple(node)) {
        const selected = pick(checkboxItems(node).map((item) => item.label));
        return selected == null
          ? null
          : chooseMultipleUntraced(node, [selected].flat(), options);
      }
      return chooseOptions(node, pick, options);
    }
    JobsWorkdayControls = Object.freeze({
      facts,
      chooseFrom,
      listbox,
      isControl,
      isPrompt,
      isDropdown,
      isMonth,
      isCheckboxGroup,
      isPaste,
      find,
      describe,
      value,
      cachedOptions,
      readOptions,
      multiple,
      expect,
      selectionValid,
    });
  })();
}
