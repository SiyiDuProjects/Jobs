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
    const close = (node) => {
      if (popupHosts(node).length) press(node, "Escape");
    };
    async function open(node, current, activate = true) {
      if (!current()) return false;
      if (activate && !popupHosts(node).length) JobsPageActions.click(node);
      return (
        !!(await wait(
          () =>
            !current() ? { cancelled: true } : roots(node).length ? true : null,
          node,
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
      let responseLoading = false,
        scrollState = "",
        scrollSteps = 0;
      const result = await wait(() => {
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
        if (matchingOptions(found, policy.target ?? answer, policy).length)
          return found;
        // Workday virtualizes long result sets. Intel's exact Physics result
        // was item 22 of 27 and did not exist in the first rendered window.
        // Scroll only this prompt's refreshed result list; wait for a different
        // rendered window before moving again, and retain exact-major matching.
        if (fresh && current() && scrollSteps < 20) {
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
              item.scrollHeight > item.clientHeight &&
              item.scrollTop + item.clientHeight < item.scrollHeight - 1,
          );
          const windowKey = found
            .map(
              (option) =>
                option.node.id +
                ":" +
                option.node.getAttribute("aria-posinset") +
                ":" +
                option.label,
            )
            .join("|");
          if (list && windowKey && windowKey !== scrollState) {
            scrollState = windowKey;
            scrollSteps++;
            list.scrollTop = Math.min(
              list.scrollHeight - list.clientHeight,
              list.scrollTop + Math.max(1, list.clientHeight * 0.8),
            );
            JobsPageActions.dispatch(
              list,
              new node.ownerDocument.defaultView.Event("scroll", {
                bubbles: true,
              }),
            );
            note(
              "auto_prompt_scroll",
              "Searching the next rendered result window",
            );
          }
        }
        return null;
      }, node);
      note(
        result ? "auto_prompt_results" : "auto_prompt_failed",
        result
          ? "Current search response observed"
          : "No matching response before deadline",
      );
      return current() ? result || [] : [];
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
        if (prompt && !append)
          container(node).setAttribute("data-jobs-expected-choice", label);
        if (!selected.target.checked) JobsPageActions.click(selected.target);
        const accepted = await wait(
          () => {
            if (!current()) return { cancelled: true };
            const actual = value(node);
            return (
              (prompt
                ? actual.some((item) => norm(item) === norm(label))
                : norm(actual) === norm(label)) &&
              node.getAttribute("aria-invalid") !== "true"
            );
          },
          node,
          1500,
        );
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
          JSON.stringify(raw) === JSON.stringify(attempt.expected))
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
          !!(parts && raw && !parseMonth(raw)) ||
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
    async function writeMonthParts(
      node,
      answer,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
      } = {},
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (
        !isMonth(node) ||
        !parseMonth(answer) ||
        !JobsPageActions.live(canProceed) ||
        !visible(node) ||
        (value(node) && !replace)
      )
        return null;
      const [year, month] = answer.split("-"),
        doc = node.ownerDocument,
        view = doc.defaultView;
      let edited = false,
        writing = false;
      const current = () =>
        !edited &&
        JobsPageActions.live(canProceed) &&
        node.isConnected &&
        visible(node) &&
        monthParts(node)?.year === parts.year &&
        monthParts(node)?.month === parts.month &&
        !parts.year.disabled &&
        !parts.month.disabled &&
        !parts.year.readOnly &&
        !parts.month.readOnly;
      const parts = monthParts(node);
      const onEdit = () => {
          if (!writing) edited = true;
        },
        inputs = [parts.year, parts.month];
      for (const input of inputs)
        for (const type of ["input", "change"])
          input.addEventListener(type, onEdit);
      const writingSync = (action) => {
        writing = true;
        try {
          return action();
        } finally {
          writing = false;
        }
      };
      try {
        if (!JobsPlatformConfig.structure.workday.modernFlow(doc)) {
          await writingSync(() =>
            JobsControlFields.writeText(parts.year, year, {
              blur: false,
              change: false,
              canProceed: current,
            }),
          );
          if (current())
            await writingSync(() =>
              JobsControlFields.writeText(parts.month, month, {
                blur: false,
                keyboard: true,
                click: true,
                canProceed: current,
              }),
            );
        } else {
          const writePart = (input, value, key, keyCode) => {
            if (!input || !current()) return;
            const setter = Object.getOwnPropertyDescriptor(
              view.HTMLInputElement.prototype,
              "value",
            )?.set;
            writingSync(() => {
              input.focus();
              for (const type of ["keydown", "keypress", "keyup"])
                JobsPageActions.dispatch(
                  input,
                  new view.KeyboardEvent(type, {
                    key,
                    keyCode,
                    bubbles: true,
                    cancelable: true,
                  }),
                );
              setter?.call(input, value);
              for (const type of ["input", "change"])
                JobsPageActions.dispatch(
                  input,
                  new view.Event(type, { bubbles: true, cancelable: true }),
                );
              input.blur();
            });
          };
          writePart(parts.year, year, "5", 53);
          await JobsDOMWait.until(
            () => current() && parts.year.value === year,
            { root: doc, timeout: 1500 },
          );
          writePart(parts.month, month, "1", 49);
        }
        return current() && value(node) === answer && !describe(node).invalid
          ? node
          : null;
      } finally {
        for (const input of inputs)
          for (const type of ["input", "change"])
            input.removeEventListener(type, onEdit);
      }
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
      // Workday normalizes 09 to 9. Leaving the group between segments commits
      // an incomplete date, which some forms turn into a year-only value.
      const matchesValue = (actual, expected) =>
        /^\d+$/.test(actual) && Number(actual) === Number(expected);
      for (let index = 0; index < group.length; index++)
        if (
          !current() ||
          !(await JobsControlFields.writeText(
            group[index],
            String(values[index]),
            {
              canProceed: current,
              click: true,
              blur: index === group.length - 1,
              matchesValue,
            },
          ))
        )
          throw Error("日期控件已变化或未接受输入，请检查该题。");
      const accepted = () =>
        current() &&
        calendarDate(`${group[0].value}/${group[1].value}/${group[2].value}`)
          ?.iso === date.iso &&
        !group.some(
          (part) =>
            part.getAttribute("aria-invalid") === "true" ||
            (part.willValidate && !part.validity.valid),
        ) &&
        !node.closest('[aria-invalid="true"]') &&
        ![
          ...(
            node.closest('[data-automation-id^="formField-"]') || node
          ).querySelectorAll(
            '[data-automation-id="inputAlert"],[data-automation-id="inputError"]',
          ),
        ].some((error) => visible(error) && text(error.textContent));
      if (
        !(await JobsDOMWait.until(accepted, {
          root: node.ownerDocument,
          timeout: 1500,
        }))
      )
        throw Error("网页尚未接受完整日期，请检查该题。");
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
    function selectionValid(node) {
      const expected = expectedSelections.get(node);
      if (!expected || expected.url !== node.ownerDocument.location.href)
        return true;
      const values = value(node);
      return (
        values.length === 1 && !!JobsOptionMatch.pick(values, expected.spec)
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
          expected = node
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
