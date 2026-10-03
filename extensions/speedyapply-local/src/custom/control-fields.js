import { JobsWorkdayControls } from "./workday-controls.js";
import { JobsOracleControls } from "./oracle-controls.js";
import { JobsTagControls } from "./tag-controls.js";
import { JobsLegacySelectControls } from "./legacy-select-controls.js";
import { JobsMenuControls } from "./menu-controls.js";
import { JobsATSChoiceControls } from "./ats-choice-controls.js";
import { JobsShadowControls } from "./shadow-controls.js";
import { JobsDisclosureControls } from "./disclosure-controls.js";
import { JobsIcimsControls } from "./icims-controls.js";
import { JobsSuccessFactorsControls } from "./successfactors-controls.js";
import { JobsGreenhouseControls } from "./greenhouse-controls.js";
import { JobsAshbyControls } from "./ashby-controls.js";
import { JobsTeslaControls } from "./tesla-controls.js";
import { JobsAriaControls } from "./aria-controls.js";
import { JobsDiagnostics } from "./diagnostics.js";
import { JobsPlatformConfig } from "./platform-config.js";
import { JobsPageActions } from "./page-actions.js";
import { JobsOptionMatch } from "./option-match.js";
import { JobsProfileAnswers } from "./profile-answers.js";
import { JobsDOMWait } from "./dom-wait.js";
import { JobsControlConfig } from "./control-config.js";
import { JobsPageSession } from "./control-content.js";
export var JobsControlFields;
let initialized = false;
export function initializeControlFields() {
  if (initialized) return;
  initialized = true;
  (() => {
    const text = (value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const empty = (value) =>
      value === "" || value == null || (Array.isArray(value) && !value.length);
    // An adapter may confirm a new entry in a reused section. Its identity
    // survives control replacement until the adapter confirms the next entry.
    const entryScopes = new WeakMap();
    function entryScope(node) {
      for (let current = node; current; current = current.parentElement)
        if (entryScopes.has(current)) return entryScopes.get(current);
      return null;
    }
    // The fields answered by picking an option: from the field's own list, or
    // (search-choice) from the results of a search whose committed values are
    // pills. Every caller uses this one list.
    // How many field scans this page has run (timing diagnostics).
    let scanned = 0,
      structuralScans = 0;
    const structureCaches = new Map();
    function dispose(scope) {
      for (const [root, entry] of structureCaches)
        if (!scope || root === scope) {
          entry.observer.disconnect();
          structureCaches.delete(root);
        }
    }
    function structure(scope, platform, ctx, enabled) {
      if (!scope) return { nodes: [], discovered: [] };
      const scopes = [scope, ...(platform.fieldRoots?.(scope) || [])];
      for (const root of structureCaches.keys())
        if (root.nodeType !== 9 && !root.isConnected) dispose(root);
      const previous = structureCaches.get(scope);
      if (
        enabled &&
        previous &&
        previous.scopes.length === scopes.length &&
        previous.scopes.every((node, index) => node === scopes[index]) &&
        !previous.observer.takeRecords().length &&
        !previous.dirty &&
        previous.nodes.every((node) => node.isConnected)
      )
        return previous;
      previous?.observer.disconnect();
      structuralScans++;
      const discovered = [
        ...scopes.flatMap((part) =>
          discoverable().flatMap(([, api]) => api.find(part)),
        ),
        ...scopes.flatMap((part) => platform.discover?.(part, ctx) || []),
      ];
      const selectors = [controlSelector, platform.selectors]
        .filter(Boolean)
        .join(",");
      const nodes = [
        ...new Set([
          ...discovered,
          ...scopes.flatMap((part) => [...part.querySelectorAll(selectors)]),
        ]),
      ];
      if (enabled) {
        const view = (scope.ownerDocument || scope).defaultView;
        const entry = {
          nodes,
          discovered,
          scopes,
          dirty: false,
          observer: null,
        };
        entry.observer = new view.MutationObserver(() => {
          entry.dirty = true;
        });
        const roots = new Set([
          ...scopes,
          ...nodes
            .map((node) => node.getRootNode())
            .filter((root) => root.host),
        ]);
        for (const root of roots)
          entry.observer.observe(root, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
        structureCaches.set(scope, entry);
      }
      return { nodes, discovered };
    }
    // A field outlives its element: a page may replace a control when it
    // commits (Workday). The field is the row that holds the node (or whose group
    // does); a node the page replaced is followed to the one row that asks the
    // same question with the same type. Ambiguity follows nothing.
    const fieldKey = (row) =>
      row.public.question +
      "\u0000" +
      row.public.type +
      "\u0000" +
      (row.identityScope || "");
    function follow(rows, node, key) {
      const own = rows.find(
        (row) => row.node === node || !!row.group?.includes(node),
      );
      if (own || node.isConnected || !key) return own || null;
      const same = rows.filter((row) => fieldKey(row) === key);
      return same.length === 1 ? same[0] : null;
    }
    const choiceTypes = Object.freeze([
      "radio",
      "yesno",
      "custom-radio",
      "select-one",
      "select-multiple",
      "combobox",
      "search-choice",
    ]);
    // Accept explicit calendar dates only. Never add a day to a month/year answer.
    function calendarDate(value) {
      if (typeof value !== "string") return null;
      const iso = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const us = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!iso && !us) return null;
      const [year, month, day] = iso
        ? [+iso[1], +iso[2], +iso[3]]
        : [+us[3], +us[1], +us[2]];
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (
        year < 1 ||
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > days[month - 1]
      )
        return null;
      return {
        year,
        month,
        day,
        iso: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      };
    }
    // One component registry for the scanner and every writing entrance, in
    // priority order. Every entry has the same contract: isControl, and either a
    // full describe (the component owns the field description) or partial facts
    // read by the common scanner; readOptions/choose write. The ARIA fallback
    // serves standard comboboxes that no site component claims.
    const registry = () =>
      [
        [
          "workday",
          JobsWorkdayControls,
          (node) =>
            "workday-" +
            (JobsWorkdayControls.isPrompt(node) ? "prompt" : "listbox"),
        ],
        ["oracle-grid", JobsOracleControls],
        ["tags", JobsTagControls],
        ["legacy-select", JobsLegacySelectControls],
        ["menu", JobsMenuControls],
        ["ats-choice", JobsATSChoiceControls],
        ["shadow", JobsShadowControls],
        ["disclosure-list", JobsDisclosureControls],
        ["icims-search", JobsIcimsControls],
        ["successfactors-paged", JobsSuccessFactorsControls],
        ["react-select", JobsGreenhouseControls],
        ["ashby-listbox", JobsAshbyControls],
        ["tesla-calendar", JobsTeslaControls],
        ["aria-combobox", JobsAriaControls, null, true],
      ].filter(([, api]) => api?.isControl);
    const discoverable = () => registry().filter(([, api]) => api.find);
    // A control claimed by two site components keeps the first owner and leaves
    // one diagnostic record, so an overlap is visible rather than silent.
    const conflicts = new WeakMap();
    function component(node) {
      let owner = null,
        fallback = null;
      const others = [];
      for (const [name, api, naming, isFallback] of registry()) {
        if (!api.isControl(node)) continue;
        const entry = { name: naming ? naming(node) : name, api };
        if (isFallback) fallback ||= entry;
        else if (owner) others.push(entry.name);
        else owner = entry;
      }
      if (others.length && conflicts.get(node) !== others.join()) {
        conflicts.set(node, others.join());
        JobsDiagnostics?.note(
          "component_conflict",
          node,
          JSON.stringify({ owner: owner.name, also: others }),
        );
      }
      return owner || fallback;
    }
    // A select's "nothing chosen" entry that uses a sentinel value instead of an
    // empty one (JazzHR "No answer" = 0, "-- Select --" = -1). Only the first
    // option, only prompt wording: a real answer is never mistaken for it.
    const placeholderWords =
      /^[-—–\s]*(?:no answer|none selected|not selected|select(?: one| an option)?|please (?:select|choose)(?: one| an option)?|choose(?: one| an option)?|make a selection)[\s.…]*[-—–\s]*$/i;
    function placeholderOption(option) {
      return (
        option?.index === 0 &&
        ["0", "-1", "-999"].includes(option.value) &&
        placeholderWords.test(text(option.textContent || option.label))
      );
    }
    // Some ATSs mark a required question only with a class on its title
    // (Ashby `_required_…`), without aria-required on the control itself.
    function markedRequired(node, platform) {
      const doc = node.ownerDocument;
      const titles = [
        ...(node.labels || []),
        ...(node.getAttribute("aria-labelledby") || "")
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => doc.getElementById(id)),
        platform.requiredTitle?.(node),
      ].filter(Boolean);
      return titles.some((title) => {
        const names = String(title.className || "");
        return (
          /(?:^|[\s_-])required(?:[\s_-]|$)/i.test(names) &&
          !/optional|not-required/i.test(names)
        );
      });
    }
    // A field keeps its identity across the adapter, answer resolver and
    // diagnostics readers, even when those readers scan different form scopes.
    const documentIdentities = new WeakMap();
    // What the common scanner reads by itself. Anything else a platform or
    // component must declare (a question group, date wrapper or custom widget).
    const controlSelector =
      'input,textarea,select,button[aria-haspopup="listbox"],[role="combobox"],[role="radiogroup"],[role="checkbox"],[contenteditable="true"]';
    // A choice input's caption when its own label is missing: the text right
    // after it (Phenom: <input value="code-2"><span>No, I do not have a disability</span>).
    const adjacentCaption = (input) =>
      input.nextElementSibling?.matches("span")
        ? text(input.nextElementSibling.textContent)
        : "";
    const caption = (input) =>
      text(
        input.labels?.[0]?.textContent ||
          (input.getAttribute("aria-labelledby") || "")
            .split(/\s+/)
            .map(
              (id) => input.ownerDocument.getElementById(id)?.textContent || "",
            )
            .join(" ")
            .trim() ||
          input.getAttribute("aria-label") ||
          input.closest("label")?.textContent ||
          "",
      ) || adjacentCaption(input);
    const commitValues = new WeakMap();
    function create(
      doc,
      root = () => doc,
      { write = false, cache = true } = {},
    ) {
      // Site structure comes from the platform declaration; the scanner itself
      // never branches on a platform id.
      const platform = JobsPlatformConfig.detect(doc);
      const unansweredOption = (option) =>
        platform.placeholder?.(option) || placeholderOption(option);
      const boxSelector = [
        "fieldset",
        '[role="radiogroup"]',
        platform.questionBox,
      ]
        .filter(Boolean)
        .join(",");
      const titleSelector = ["legend", platform.questionTitle]
        .filter(Boolean)
        .join(",");
      if (!documentIdentities.has(doc))
        documentIdentities.set(doc, { ids: new WeakMap(), counter: 0 });
      const identity = documentIdentities.get(doc);
      const id = (node) => {
        if (!identity.ids.has(node))
          identity.ids.set(node, "field-" + ++identity.counter);
        return identity.ids.get(node);
      };
      function visible(node) {
        if (
          !node.isConnected ||
          node.closest('[hidden],[inert],[aria-hidden="true"]')
        )
          return false;
        for (
          let current = node;
          current?.nodeType === 1;
          current = current.parentElement || current.getRootNode?.().host
        ) {
          if (current.matches('[hidden],[inert],[aria-hidden="true"]'))
            return false;
          const style = doc.defaultView.getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden")
            return false;
        }
        return true;
      }
      function textOnly(node) {
        if (!node) return "";
        const copy = node.cloneNode(true);
        copy
          .querySelectorAll?.(
            "input,textarea,select,[contenteditable],script,style",
          )
          .forEach((child) => child.remove());
        return text(copy.textContent);
      }
      const linkedText = (node) =>
        text(
          (node.getAttribute("aria-labelledby") || "")
            .split(/\s+/)
            .filter(Boolean)
            .map((i) => textOnly(doc.getElementById(i)))
            .join(" "),
        );
      const ctx = {
        doc,
        root,
        text,
        textOnly,
        visible,
        linkedText,
        labelled,
        question,
        response,
      };
      const pageFailure = () => platform.failure?.(ctx) || null;
      const errorSummary = () =>
        platform.errorSummary?.(root(), ctx) || { nodes: [], titles: [] };
      function labelled(node) {
        const own = platform.label?.(node, ctx);
        if (own !== undefined) return own;
        return (
          linkedText(node) ||
          text(
            node.getAttribute("aria-label") ||
              Array.from(node.labels || [])
                .map(textOnly)
                .join(" "),
          )
        );
      }
      function question(node, grouped = false) {
        const own = platform.question?.(node, grouped, ctx);
        if (own !== undefined) return own;
        const box = node.closest(boxSelector);
        const title = box?.querySelector(titleSelector);
        const immediate = platform.questionTitle
          ? node.parentElement?.querySelector(
              ":scope > " + platform.questionTitle,
            )
          : null;
        return text(
          (grouped && (title?.textContent || (box && labelled(box)))) ||
            labelled(node) ||
            immediate?.textContent ||
            title?.textContent ||
            node.getAttribute("placeholder"),
        ).slice(0, 700);
      }
      const dateParts = (node) => platform.dateParts?.(node, ctx) || null;
      function dateValue(parts) {
        const values = parts.map((part) => text(part.value));
        if (values.every((value) => !value)) return "";
        const [month, day, year] = values;
        return (
          calendarDate(`${month}/${day}/${year}`)?.iso ||
          values.map((value) => value || "__").join("/")
        );
      }
      async function readOptions(
        row,
        canProceed = /** @type {() => boolean} */ (() => true),
        context = {},
      ) {
        canProceed = JobsPageActions.guard(canProceed);
        const url = doc.location.href,
          scope = root();
        const active = () =>
          JobsPageActions.live(canProceed) &&
          doc.location.href === url &&
          root() === scope;
        const current = () =>
          active() &&
          scan().some(
            (fresh) =>
              fresh.node === row.node &&
              fresh.public.type === row.public.type &&
              fresh.public.question === row.public.question,
          );
        if (!current()) return [];
        JobsDiagnostics?.note(
          "auto_options_wait",
          row.node,
          row.public.question,
        );
        // The caller passes the field's one decision (its spec, answer and
        // several answers); reading options never decides an answer. Each search
        // term in turn: the first results the rule can pick from are read, else
        // the first results found (candidates for the model).
        let options = [];
        if (component(row.node))
          for (const term of searchTerms(context.optionSpec, context.answer)) {
            const found =
              (await component(row.node).api.readOptions(row.node, active, {
                ...context,
                answer: term,
              })) || [];
            if (!current()) return [];
            if (found.length && !options.length) options = found;
            if (
              found.length &&
              (!context.optionSpec ||
                JobsOptionMatch.pick(
                  found.map((option) => option.label),
                  context.optionSpec,
                ))
            ) {
              options = found;
              break;
            }
          }
        if (!options.length) options = row.public.options || [];
        if (!current()) return [];
        JobsDiagnostics?.note(
          options.length ? "auto_options_ready" : "auto_options_unavailable",
          row.node,
          options.length ? String(options.length) : row.public.question,
        );
        return options;
      }
      // Normalize exposed choices once, retaining ambiguity as unsupported.
      function normalizeOptions(options) {
        if (!options) return { options, supported: true };
        let supported = true;

        // Some real native lists repeat exactly the same value and label.
        // Those are one answer; conflicting labels for one value are ambiguous.
        const unique = new Map();
        for (const option of options) {
          if (
            unique.has(option.value) &&
            unique.get(option.value).label !== option.label
          )
            supported = false;
          else unique.set(option.value, option);
        }
        options = [...unique.values()];
        if (
          options.length > 1000 ||
          options.some((option) => option.value.length > 2000)
        )
          supported = false;
        options = options
          .filter((option) => option.value.length <= 2000)
          .slice(0, 1000)
          .map((option) => ({
            ...option,
            label: option.label.slice(0, 500),
          }));

        return { options, supported };
      }
      // Apply form-wide errors and dependency state after all canonical rows exist.
      function annotateCompletion(rows) {
        const title = (value) =>
          text(value)
            .replace(/\s*\*\s*$/, "")
            .toLowerCase();
        for (const target of errorSummary().titles) {
          const matches = rows.filter(
            (row) => title(row.public.question) === title(target),
          );
          if (matches.length === 1) {
            matches[0].public.invalid = true;
            matches[0].public.completion = completion(matches[0].public);
          }
        }
        for (const row of rows)
          if (row.dependsOn) {
            const parents = row.dependsOn.map((node) =>
              rows.find((candidate) => candidate.node === node),
            );
            row.public.dependsOn = parents
              .filter(Boolean)
              .map((parent) => parent.public.id);
            row.public.dependencyBlocked = parents.some(
              (parent) =>
                !parent || !parent.public.filled || !complete(parent.public),
            );
          }
        platform.conditions?.(rows, ctx);
        return rows;
      }
      let scannedNodes;
      function scan(only = null) {
        if (!only) scanned++;
        const rows = [],
          seen = new Set();
        const scope = root();
        // Component and platform discovery is read-only. Canonical fields come
        // before their search inputs/backing selects so one question is scanned
        // exactly once.
        const { discovered, nodes } = structure(scope, platform, ctx, cache);
        scannedNodes = nodes;
        const canonical = new Set(discovered);
        for (const node of nodes) {
          if (only && !only.has(node)) continue;
          const owner = component(node);
          const details = owner?.api.describe?.(node);
          const facts = details ? null : owner?.api.facts?.(node, ctx) || null;
          if (details?.disabled)
            for (const member of details.group || [])
              if (!canonical.has(member) || member === node) seen.add(member);
          if (
            seen.has(node) ||
            !visible(node) ||
            node.disabled ||
            details?.disabled ||
            (node.readOnly && !details && !facts?.readonly) ||
            node.getAttribute("aria-disabled") === "true"
          )
            continue;
          if (
            node.matches(
              'input[type="hidden"],input[type="password"],input[type="submit"],input[type="button"],input[type="reset"],input[type="image"]',
            ) ||
            details?.group?.some((member) =>
              member.matches?.('input[type="password"]'),
            ) ||
            platform.skip?.(node, ctx)
          )
            continue;
          const parts = details?.dateParts || dateParts(node);
          // One question formed by several inputs: an exclusive group uses radio
          // semantics, a multiple group checkbox-set semantics.
          const choice = details
            ? null
            : platform.choiceGroup?.(node, ctx) || null;
          const singleChoice = choice?.exclusive ? choice : null,
            checkboxGroup = !!choice?.multiple;
          // A matched container (fieldset, date wrapper, question block) is a
          // field only when something declares what it holds.
          if (
            !details &&
            !facts &&
            !parts &&
            !choice &&
            !node.matches(controlSelector)
          )
            continue;
          let kind =
            details?.type ||
            (parts
              ? "date"
              : checkboxGroup
                ? "select-multiple"
                : singleChoice
                  ? "radio"
                  : choice?.yesno
                    ? "yesno"
                    : facts?.type ||
                      (node.matches("select")
                        ? node.type
                        : node.getAttribute("role") === "combobox"
                          ? "combobox"
                          : node.getAttribute("role") === "radiogroup"
                            ? "custom-radio"
                            : node.getAttribute("role") === "checkbox" &&
                                !node.matches("input")
                              ? "custom-checkbox"
                              : node.type ||
                                (node.isContentEditable
                                  ? "contenteditable"
                                  : "text")));
          if (
            !details &&
            kind === "custom-radio" &&
            node.querySelector('input[type="radio"]')
          )
            continue;
          let group = [node],
            options,
            value = /** @type {string | boolean | string[]} */ (""),
            supported = true,
            completionReadable = false,
            label;
          if (details) {
            group = [
              ...new Set([
                node,
                ...(details.group || []).filter(
                  (member) => !canonical.has(member) || member === node,
                ),
              ]),
            ];
            group.forEach((member) => seen.add(member));
            value = details.value;
            label = details.question;
            supported = details.supported === true;
            completionReadable = details.readable === true;
            options = details.options;
          } else if (parts) {
            group = parts;
            group.forEach((part) => seen.add(part));
            value = dateValue(parts);
            label = question(node, true);
            supported = parts.every(
              (part) =>
                visible(part) &&
                !part.disabled &&
                !part.readOnly &&
                part.getAttribute("aria-disabled") !== "true",
            );
          } else if (checkboxGroup) {
            // The fieldset is the question; unchecked options are not unanswered questions.
            group = Array.from(
              node.querySelectorAll('input[type="checkbox"]'),
            ).filter(visible);
            group.forEach((other) => seen.add(other));
            options = group
              .filter((other) => !other.disabled || other.checked)
              .map((other) => ({ value: id(other), label: labelled(other) }));
            value = group.filter((other) => other.checked).map(id);
            label = choice.question || question(node, true);
            supported =
              options.length > 0 && options.every((option) => option.label);
          } else if (facts) {
            // A component that reads the committed value while the scanner keeps
            // the common label, required and validation interpretation.
            value = facts.value ?? "";
            supported = facts.supported === true;
            completionReadable = facts.readable === true;
            options = facts.options;
            if (facts.question) label = facts.question;
            if (facts.multiple) kind = "select-multiple";
          } else if (kind === "radio") {
            const container = node.form || doc;
            group =
              singleChoice?.group ||
              Array.from(
                container.querySelectorAll('input[type="radio"]'),
              ).filter(
                (other) =>
                  other.name && other.name === node.name && visible(other),
              );
            if (!group.length) group = [node];
            group.forEach((other) => seen.add(other));
            options = group.map((other) => ({
              value: id(other),
              label: (labelled(other) || adjacentCaption(other)).slice(0, 500),
            }));
            const checked = group.find((other) => other.checked);
            value = checked ? id(checked) : "";
            label = singleChoice?.question || question(node, true);
            if (platform.radioQuestion)
              label = platform.radioQuestion(node, label, ctx);
            // Native radio sets often use a div title instead of a legend.
            if (!label || label === labelled(node)) {
              const common =
                node.closest('fieldset,[role="radiogroup"]') ||
                node.parentElement?.parentElement;
              label = text(
                common?.querySelector(titleSelector)?.textContent || label,
              );
            }
            supported =
              options.every((option) => option.label) &&
              new Set(options.map((option) => option.value)).size ===
                options.length;
          } else if (kind === "yesno") {
            group = Array.from(node.querySelectorAll("button[data-option]"));
            options = group.map((button) => ({
              value: button.dataset.option,
              label: text(button.textContent),
            }));
            value =
              group.find(
                (button) => button.getAttribute("aria-pressed") === "true",
              )?.dataset.option ?? "";
            label = question(node, true);
            supported = options.length === 2;
          } else if (kind === "select-one" || kind === "select-multiple") {
            // Some selects use a nonempty value for their unanswered placeholder.
            // Share the same interpretation with supplementation, review and readiness.
            options = Array.from(node.options)
              .filter((option) => !option.disabled && !unansweredOption(option))
              .map((option) => ({
                value: option.value,
                label: text(option.label),
              }));
            const selected = Array.from(node.selectedOptions).filter(
              (option) => !unansweredOption(option),
            );
            value = node.multiple
              ? selected.map((option) => option.value).filter(Boolean)
              : (selected[0]?.value ?? "");
          } else if (kind === "checkbox" || kind === "custom-checkbox") {
            value = (
              kind === "checkbox"
                ? node.checked
                : node.getAttribute("aria-checked") === "true"
            )
              ? true
              : "";
            supported = true;
            const parent = node.closest(
              ["fieldset", '[role="group"]', platform.questionBox]
                .filter(Boolean)
                .join(","),
            );
            const heading = text(
              parent?.querySelector(titleSelector)?.textContent ||
                (parent && labelled(parent)),
            );
            const option = labelled(node) || text(node.textContent);
            // Each checkbox remains one boolean answer; never flatten a set into
            // an ambiguous string or reuse an option label under another question.
            label =
              heading && option && heading !== option
                ? heading + " — " + option
                : heading || option;
          } else if (kind === "file") {
            value = node.files?.length ? "[attached]" : "";
            supported = false;
            completionReadable = true;
          } else if (kind === "combobox") {
            value =
              node.getAttribute("aria-expanded") === "true"
                ? ""
                : node.value || "";
            supported = !!owner;
            // A visible control backed by a hidden native select reads the
            // committed selection, not its search input.
            const backed = platform.combobox?.(node, ctx);
            if (backed) {
              value = backed.value;
              backed.seen.forEach((item) => seen.add(item));
            }
          } else if (kind === "custom-radio") {
            group = Array.from(node.querySelectorAll('[role="radio"]'));
            options = group.map((other) => ({
              value: id(other),
              label: labelled(other) || text(other.textContent),
            }));
            value = group.find(
              (other) => other.getAttribute("aria-checked") === "true",
            );
            value = value ? id(value) : "";
            label = question(node, true);
            supported =
              options.length > 0 && options.every((option) => option.label);
          } else if (node.getAttribute("contenteditable") === "true") {
            supported = false;
            value = text(node.textContent);
          } else {
            value = node.value ?? "";
            supported =
              node.matches("textarea,input") &&
              [
                "text",
                "textarea",
                "email",
                "tel",
                "url",
                "number",
                "date",
                "month",
                "search",
              ].includes(kind);
          }
          const oracle = JobsOracleControls?.metadata(node);
          label ||= oracle?.question || question(node);
          if (platform.cleanLabel) label = platform.cleanLabel(label);
          const normalizedOptions = normalizeOptions(options);
          options = normalizedOptions.options;
          supported = supported && normalizedOptions.supported;
          // Do not expose or fill account secrets/verification codes just because
          // a site renders them as ordinary text instead of password inputs.
          if (
            /password|passcode|one.?time|verification code|social security|\bssn\b|credit card/i.test(
              label + " " + node.name + " " + node.autocomplete,
            )
          )
            continue;
          // Writable: the control can be operated (an adapter that knows it by id may write it).
          // Supported: the question is also known, so rules, AI and remote review may answer it.
          const writable = details
            ? (details.writable ?? details.supported) === true
            : supported;
          if (!label) supported = false;
          // Required markers can occur beyond the shortened question text.
          const labelRequired =
            /\*\s*$/.test(label) ||
            /\*\s*$/.test(labelled(node)) ||
            markedRequired(node, platform);
          const required =
            details?.requiredKnown === true
              ? details.required === true
              : oracle?.required === true ||
                details?.required === true ||
                facts?.required === true ||
                node.getAttribute("aria-required") === "true" ||
                node.closest('[role="radiogroup"][aria-required="true"]') !=
                  null ||
                group.some(
                  (other) =>
                    other.required ||
                    other.getAttribute("aria-required") === "true",
                ) ||
                labelRequired ||
                !!platform.required?.(node, ctx);
          const conflictingYesNo =
            choice?.singleYesNo &&
            Array.isArray(value) &&
            value.length > 1 &&
            options.length === 2 &&
            options.every((option) => /^(yes|no)$/i.test(option.label));
          const invalid = details
            ? details.invalid === true
            : oracle?.invalid === true ||
              facts?.invalid === true ||
              !!conflictingYesNo ||
              !!(parts && value && !calendarDate(value)) ||
              node.closest('[aria-invalid="true"]') != null ||
              group.some(
                (other) =>
                  other.getAttribute("aria-invalid") === "true" ||
                  (other.willValidate &&
                    !other.validity.valid &&
                    !(
                      choice?.requiredAsGroup &&
                      Array.isArray(value) &&
                      value.length &&
                      other.validity.valueMissing &&
                      !other.validity.customError
                    )),
              );
          // Declared optional blanks are not missing answers: a rule may fill
          // them, but they never trigger supplemental AI.
          const skipSupplement =
            (platform.optionalSupplement === false ||
              facts?.optionalSupplement === false) &&
            !required &&
            !invalid;
          const readable = details
            ? completionReadable
            : completionReadable || supported || !!owner;
          const optionalSurvey = !!platform.optionalSurvey?.(node, ctx);
          // Which education entry a field belongs to is page structure (its
          // section); the rule layer uses it to pick that entry's facts.
          const educationIndex =
            details?.educationIndex ?? facts?.educationIndex;
          const descriptor = {
            id: id(node),
            question: label || "Unlabelled control",
            type: kind,
            required,
            filled: !empty(value),
            invalid,
            supported,
            completion: "",
            ...(node.dataset?.jobsTopic
              ? { topicHint: node.dataset.jobsTopic }
              : {}),
            ...(optionalSurvey ? { optionalSurvey: true } : {}),
            ...(Number.isInteger(educationIndex) ? { educationIndex } : {}),
            requiredKnown:
              required ||
              (details
                ? details.requiredKnown === true
                : readable ||
                  node.matches("input,textarea,select") ||
                  node.hasAttribute("aria-required")),
            component:
              details?.component ||
              owner?.name ||
              (parts ? "segmented-date" : kind),
            ...(details?.commitState === "unconfirmed"
              ? { commitState: "unconfirmed" }
              : {}),
            capabilities: {
              read: readable,
              write: supported,
              options: !!options || !!owner,
            },
            completionReadable: readable,
            ...(skipSupplement ? { supplement: false } : {}),
            ...(options ? { options } : {}),
          };
          descriptor.completion = completion(descriptor);
          const identityScope = entryScope(node) || platform.fieldScope?.(node);
          rows.push({
            node,
            group,
            // Repeated entries are separate fields even when one editor closes
            // before the next opens. A replacement inside the same entry follows.
            identityScope: identityScope ? id(identityScope) : "",
            ...(details?.answerContext
              ? { answerContext: details.answerContext }
              : {}),
            ...(details?.dependsOn?.length
              ? { dependsOn: details.dependsOn }
              : {}),
            ...(parts ? { dateParts: parts } : {}),
            raw: value,
            writable,
            public: descriptor,
          });
        }
        return annotateCompletion(rows);
      }
      // Reuse discovery, never a field's old value/validity. Structural changes
      // and cross-field conditions require the complete canonical scan again.
      // Error-summary titles also need every row to detect ambiguous matches.
      function read(row) {
        const current = structure(root(), platform, ctx, cache);
        const narrow =
          current.nodes === scannedNodes &&
          row.node.isConnected &&
          !platform.conditions &&
          !errorSummary().titles.length &&
          !component(row.node) &&
          !row.dependsOn?.length;
        return scan(narrow ? new Set([row.node]) : null).find(
          (item) => item.node === row.node,
        );
      }
      // Every value written by the supplement, known answers, AI, remote review and
      // shared adapter entrances leaves one decision record: what was asked,
      // what the control holds afterwards, or why the write stopped.
      async function apply(
        row,
        value,
        canProceed = /** @type {() => boolean} */ (() => true),
        options = {},
      ) {
        const fresh = validateRow(row);
        if (
          !fresh.writable ||
          ((fresh.public.filled ||
            fresh.public.commitState === "unconfirmed") &&
            !options.replace)
        )
          throw Error("Field is no longer an editable empty control");
        if (
          fresh.public.conditional &&
          fresh.public.conditional.active !== true
        )
          throw Error("Field condition is not active");
        let failure;
        const result = await chooseSpec(
          row.node,
          literalSpec(row.node, value, row),
          {
            ...options,
            canProceed,
            onFailure: (error) => {
              failure = error;
            },
          },
        );
        if (!result && failure) throw failure;
        const after =
          scan().find((item) => item.node === row.node) || replacement(row);
        if (after?.public.invalid) throw Error("Field still fails validation");
        if (!result) throw Error("Control change was not committed");
        return result;
      }
      function validateRow(row) {
        const fresh = scan().find((item) => item.node === row.node);
        if (
          !fresh ||
          fresh.public.type !== row.public.type ||
          fresh.public.question !== row.public.question ||
          (row.group &&
            !component(row.node) &&
            (row.group.length !== fresh.group?.length ||
              row.group.some((node, index) => node !== fresh.group[index]))) ||
          JSON.stringify(fresh.public.conditional) !==
            JSON.stringify(row.public.conditional)
        )
          throw Error("Field changed before writing");
        return fresh;
      }
      async function applyValue(
        row,
        value,
        canProceed = /** @type {() => boolean} */ (() => true),
        { replace = false } = /** @type {{replace?: boolean}} */ ({}),
      ) {
        canProceed = JobsPageActions.guard(canProceed);
        row = validateRow(row);
        if (row.public.conditional && row.public.conditional.active !== true)
          throw Error("Field condition is not active");
        const { node, group } = row,
          kind = row.public.type,
          view = doc.defaultView;
        if (
          !JobsPageActions.live(canProceed) ||
          !row.writable ||
          ((row.public.filled || row.public.commitState === "unconfirmed") &&
            !replace) ||
          !visible(node) ||
          node.disabled ||
          (node.readOnly &&
            !component(node)?.api.describe &&
            !component(node)?.api.facts?.(node, ctx)?.readonly)
        )
          throw Error("Field is no longer an editable empty control");
        JobsDiagnostics?.note(
          "auto_control_write",
          node,
          JSON.stringify({
            component: row.public.component,
            required: row.public.required,
            replace,
          }),
        );
        if (component(node)) {
          const api = component(node).api;
          // Only text, calendar and boolean rows reach this private primitive.
          // Option rows always transact through chooseSpec's matching callback.
          const accepted = await api.chooseFrom(node, () => value, {
            canProceed,
            replace,
          });
          if (!accepted) throw Error("Control change was not committed");
        } else if (row.dateParts) {
          await JobsWorkdayControls.chooseFrom(node, () => value, {
            canProceed,
          });
        } else if (
          kind === "radio" ||
          kind === "yesno" ||
          kind === "custom-radio"
        ) {
          const options = row.public.options.filter(
            (option) => option.value === value || option.label === value,
          );
          if (options.length !== 1)
            throw Error("Answer must match exactly one option");
          const target = group.find(
            (element) =>
              (kind === "yesno" ? element.dataset.option : id(element)) ===
              options[0].value,
          );
          if (
            !target ||
            target.disabled ||
            target.getAttribute("aria-disabled") === "true"
          )
            throw Error("Option is disabled");
          if (
            !(await writeChoice(target, {
              canProceed,
              attribute:
                kind === "radio"
                  ? null
                  : kind === "yesno"
                    ? "aria-pressed"
                    : "aria-checked",
            }))
          )
            throw Error("Selection was not committed");
        } else if (kind === "checkbox" || kind === "custom-checkbox") {
          if (typeof value !== "boolean")
            throw Error("Checkbox answer must be boolean");
          if (!(await writeChecked(node, value, { canProceed })))
            throw Error("Checkbox change was not committed");
        } else if (kind === "select-multiple" && !node.matches("select")) {
          if (
            !Array.isArray(value) ||
            new Set(value).size !== value.length ||
            value.some(
              (item) =>
                !row.public.options.some((option) => option.value === item),
            )
          )
            throw Error("Answer must match existing option values");
          const desired = new Set(value);
          const valid = () =>
            JobsPageActions.live(canProceed) &&
            visible(node) &&
            !node.disabled &&
            group.every(
              (other) =>
                other.isConnected && node.contains(other) && visible(other),
            );
          if (
            !valid() ||
            group.some(
              (other) =>
                other.checked !== desired.has(id(other)) &&
                (other.disabled ||
                  other.getAttribute("aria-disabled") === "true"),
            )
          )
            throw Error("Option is disabled or changed");
          for (const other of group) {
            if (!valid()) throw Error("Checkbox group changed while answering");
            if (other.checked !== desired.has(id(other))) {
              if (
                other.disabled ||
                other.getAttribute("aria-disabled") === "true"
              )
                throw Error("Option is disabled");
              if (
                !(await writeChecked(other, desired.has(id(other)), {
                  canProceed: valid,
                }))
              )
                throw Error("Checkbox change was not committed");
            }
          }
          const committed = () =>
            valid() &&
            group.every((other) => other.checked === desired.has(id(other)));
          if (
            !committed() &&
            !(await JobsDOMWait?.until(committed, {
              root: node,
              timeout: 1200,
            }))
          )
            throw Error("Selection was not committed");
        } else if (kind.startsWith("select-")) {
          const values = node.multiple ? value : [value];
          if (
            !Array.isArray(values) ||
            values.some(
              (item) =>
                !row.public.options.some((option) => option.value === item),
            )
          )
            throw Error("Answer must match existing option values");
          if (!writeSelect(node, values, { input: false }))
            throw Error("Selection was not committed");
          const actual = Array.from(node.selectedOptions).map(
            (option) => option.value,
          );
          if (
            actual.length !== values.length ||
            values.some((item) => !actual.includes(item))
          )
            throw Error("Selection was not committed");
        } else {
          if (typeof value !== "string" || !value.trim())
            throw Error("Text answer is empty");
          // Workday swaps the input for a new element right after the write; the
          // field is then the one row with the same question and type.
          if (
            !(await writeText(node, value, { canProceed })) &&
            replacement(row)?.node.value !== value
          )
            throw Error("Input value was not committed");
        }
        const after =
          scan().find((item) => item.node === node) || replacement(row);
        if (after?.public.invalid) throw Error("Field still fails validation");
        JobsDiagnostics?.note(
          "auto_control_result",
          node,
          JSON.stringify({
            component: row.public.component,
            completion: after?.public.completion || "detached",
          }),
        );
      }
      // A row whose element the page replaced: the unique row with its question and type.
      function replacement(row) {
        return row.node.isConnected
          ? null
          : follow(scan(), row.node, fieldKey(row));
      }
      function response(row) {
        const { node, raw, public: field } = row;
        if (
          !node.isConnected ||
          node.disabled ||
          (node.readOnly && !component(node)?.api.describe) ||
          field.invalid ||
          (field.conditional && field.conditional.active !== true) ||
          field.commitState === "unconfirmed" ||
          field.capabilities?.read === false ||
          !field.question ||
          field.question === "Unlabelled control"
        )
          return null;
        let answer;
        if (
          ["radio", "yesno", "custom-radio", "select-one"].includes(field.type)
        )
          answer = field.options?.find((option) => option.value === raw)?.label;
        else if (field.type === "select-multiple")
          answer =
            component(node) && Array.isArray(raw)
              ? raw.join("; ")
              : field.options
                  ?.filter((option) => raw.includes(option.value))
                  .map((option) => option.label)
                  .join("; ");
        else if (["checkbox", "custom-checkbox"].includes(field.type)) {
          if (
            node.indeterminate ||
            node.getAttribute("aria-checked") === "mixed"
          )
            return null;
          answer = raw === true ? "Yes" : "No";
        } else if (field.type === "search-choice") answer = raw.join("; ");
        else if (field.type === "combobox") {
          if (node.getAttribute("aria-expanded") === "true") return null;
          answer = raw;
        } else if (
          !["file", "select-multiple", "contenteditable"].includes(field.type)
        )
          answer = raw;
        if (
          typeof answer !== "string" ||
          !answer.trim() ||
          (field.type === "select-one" && !raw)
        )
          return null;
        return { question: field.question, response: answer.trim() };
      }
      // The reverse check: questions on the page that the scanner did not turn
      // into a field. A required-marked title with no field around it, or an
      // interactive element no reader or component took, is reported with its
      // structure (tags, roles, classes; never text values), so a missed control
      // is visible in the record instead of silently skipped.
      const interactiveSelector =
        'input,select,textarea,button,[role],[contenteditable]:not([contenteditable="false"])';
      const unownedSelector =
        '[role="textbox"],[role="searchbox"],[role="switch"],[role="spinbutton"],[role="slider"],[role="radio"],[role="listbox"],' +
        '[aria-haspopup]:not([aria-haspopup="false"]),[contenteditable]:not([contenteditable="false"]),[aria-required="true"],[required]';
      const inline = "span,abbr,sup,strong,b,em,i,small";
      const excluded = (node) =>
        !!node.closest(
          '[data-jobs-diagnostics],[id^="jobs-"],[class^="jobs-"]',
        );
      // Uploads belong to the adapter's resume step; after a file is attached
      // the widget may no longer contain its input.
      const uploadClass =
        /(?:^|[-_])(?:file|upload|dropzone|attachment)s?(?:[-_]|$)/i;
      const secretBlock = (block) =>
        block.querySelector('input[type="password"],input[type="file"]') ||
        /password|passcode|verification code|social security|\bssn\b/i.test(
          textOnly(block).slice(0, 400),
        ) ||
        [block, ...block.querySelectorAll("[class]")].some((node) =>
          [...node.classList].some((name) => uploadClass.test(name)),
        );
      function outline(node, depth = 0, budget = { count: 0 }) {
        if (budget.count >= 24 || depth > 3 || node.nodeType !== 1) return [];
        budget.count++;
        const attrs = [
          "role",
          "type",
          "aria-haspopup",
          "aria-expanded",
          "aria-required",
          "contenteditable",
          "tabindex",
        ]
          .filter((name) => node.hasAttribute(name))
          .map(
            (name) =>
              `[${name}=${String(node.getAttribute(name)).slice(0, 20)}]`,
          )
          .join("");
        const classes = [...node.classList]
          .filter((name) => /^[a-zA-Z_][\w-]{0,40}$/.test(name))
          .slice(0, 3)
          .map((name) => "." + name)
          .join("");
        return [
          "  ".repeat(depth) +
            node.localName +
            classes +
            attrs +
            (visible(node) ? "" : " (hidden)") +
            (node.shadowRoot ? " (shadow)" : ""),
          ...[...node.children].flatMap((child) =>
            outline(child, depth + 1, budget),
          ),
        ];
      }
      function unrecognized(rows = scan()) {
        const scope = root();
        if (!scope) return [];
        const covered = rows
          .flatMap((row) => [row.node, ...(row.group || [])])
          .filter(Boolean);
        const holds = (block) =>
          covered.some(
            (node) =>
              block === node || block.contains(node) || node.contains(block),
          );
        // A question's block: the title's or element's own wrapper, climbing only
        // through wrappers that hold nothing else (a label alone in its column).
        const blockOf = (start) => {
          let node = start.parentElement;
          for (
            let depth = 0;
            node && node !== scope && depth < 3 && node.children.length < 2;
            depth++
          )
            node = node.parentElement;
          return node;
        };
        const found = [],
          blocks = new Set();
        const report = (block, question, reason) => {
          if (
            found.length >= 20 ||
            !block ||
            blocks.has(block) ||
            holds(block) ||
            excluded(block) ||
            secretBlock(block)
          )
            return;
          blocks.add(block);
          found.push({
            node: block,
            question: text(question).slice(0, 200) || "Unlabelled question",
            reason,
            structure: outline(block).join("\n").slice(0, 800),
          });
        };
        // Interactive elements that the scanner did not read.
        const scopes = [scope, ...(platform.fieldRoots?.(scope) || [])];
        for (const node of scopes.flatMap((part) => [
          ...part.querySelectorAll(unownedSelector),
        ])) {
          if (
            !visible(node) ||
            node.disabled ||
            holds(node) ||
            excluded(node) ||
            platform.skip?.(node, ctx) ||
            node.matches(
              'input[type="hidden"],input[type="password"],input[type="file"],input[type="submit"],input[type="button"],input[type="reset"],input[type="image"],button:not([aria-haspopup])',
            )
          )
            continue;
          const block = node.closest(boxSelector) || blockOf(node);
          report(
            block,
            labelled(node) ||
              question(node) ||
              textOnly(block?.querySelector(titleSelector + ",label")),
            "interactive-without-field",
          );
        }
        // Required markers ("Question *") whose question block holds no field.
        for (const part of scopes) {
          const walker = doc.createTreeWalker(
            part,
            doc.defaultView.NodeFilter.SHOW_TEXT,
          );
          for (let marker; (marker = walker.nextNode()) && found.length < 20;) {
            if (!/[*✱]\s*$/.test(marker.nodeValue)) continue;
            let title = marker.parentElement;
            while (title && title !== scope && title.matches(inline))
              title = title.parentElement;
            if (platform.readOnlySummary?.(title, ctx)) continue;
            if (
              !title ||
              title === scope ||
              !visible(title) ||
              excluded(title) ||
              (title.control && holds(title.control))
            )
              continue;
            const words = textOnly(title)
              .replace(/[*✱]\s*$/, "")
              .trim();
            if (
              words.length < 2 ||
              words.length > 300 ||
              title.querySelector(interactiveSelector)
            )
              continue;
            report(blockOf(title), words, "required-title-without-field");
          }
        }
        return found;
      }
      function state({ review = false } = {}) {
        const scope = root(),
          rows = scan();
        const failure = pageFailure();
        // Live regions also announce successful uploads and ordinary progress.
        // Only actual field validation / ATS error surfaces block navigation.
        const errors = [
          ...(scope?.querySelectorAll(
            [".error-message", platform.errorSelector]
              .filter(Boolean)
              .join(","),
          ) || []),
        ].filter((node) => visible(node) && text(node.textContent));
        errors.push(
          ...errorSummary().nodes.filter((node) => !errors.includes(node)),
        );
        const invalid = rows.filter((row) =>
          ["invalid", "required-empty"].includes(completion(row.public)),
        );
        const busy = [
          ...(scope?.querySelectorAll(
            '[aria-busy="true"],[role="progressbar"]',
          ) || []),
        ].some(visible);
        const unsupported = rows.some(
          (row) => !complete(row.public) && !invalid.includes(row),
        );
        const blockers = rows
          .filter((row) => !complete(row.public))
          .map((row) => ({
            fieldId: row.public.id,
            component: row.public.component,
            reason: completion(row.public),
          }));
        return {
          rows,
          errors,
          invalid,
          busy,
          failure,
          blockers,
          ready:
            !!scope &&
            (rows.length > 0 || review) &&
            !failure &&
            !busy &&
            !errors.length &&
            !invalid.length &&
            !unsupported,
          phase: failure
            ? "site-error"
            : errors.length || invalid.length
              ? "complete-required"
              : unsupported
                ? "complete-manually"
                : "page-complete",
        };
      }
      async function settle(
        {
          review = false,
          selector,
          target,
          canProceed = /** @type {() => boolean} */ (() => true),
          timeout = 2500,
          pending,
          beforeReady,
        } = /** @type {{review?:boolean, selector?:string, target?:HTMLButtonElement|HTMLInputElement, canProceed?:()=>boolean, timeout?:number, pending?:(row:ReturnType<typeof scan>[number])=>boolean, beforeReady?:()=>unknown}} */ ({}),
      ) {
        canProceed = JobsPageActions.guard(canProceed);
        let deadline = Date.now() + timeout;
        let previous = "",
          since = Date.now();
        const buttonsNow = () =>
          (target
            ? [target]
            : selector
              ? [...doc.querySelectorAll(selector)]
              : []
          ).filter(
            (node) =>
              visible(node) &&
              !node.disabled &&
              node.getAttribute("aria-disabled") !== "true",
          );
        const fingerprintOf = (current) =>
          JSON.stringify(current.rows.map((row) => [row.public, row.raw]));
        while (
          Date.now() < deadline &&
          JobsPageActions.live(canProceed) &&
          root() &&
          visible(root())
        ) {
          const current = state({ review });
          if (current.failure) return null;
          const buttons = buttonsNow();
          const fingerprint = fingerprintOf(current);
          const gaps = !!pending && current.rows.some(pending);
          // An empty intermediate render is no more authoritative than a filled
          // one. Both must survive the same quiet interval before acting.
          if (
            current.busy ||
            fingerprint !== previous ||
            (!gaps &&
              (!current.ready ||
                ((selector || target) && buttons.length !== 1)))
          ) {
            since = Date.now();
            previous = fingerprint;
          } else if (Date.now() - since >= 200) {
            if (gaps) return { state: current, pending: true };
            // Async authorization belongs inside the readiness barrier. Its
            // result cannot authorize a DOM snapshot that changed while waiting.
            // Network authorization has its own timeout. Its elapsed time must
            // not consume the DOM stability budget; always re-read afterwards.
            if (beforeReady) {
              const checking = Date.now();
              await beforeReady();
              deadline += Date.now() - checking;
              if (
                Date.now() >= deadline ||
                !JobsPageActions.live(canProceed) ||
                !root() ||
                !visible(root())
              )
                return null;
              const verified = state({ review }),
                verifiedButtons = buttonsNow();
              if (
                !verified.ready ||
                fingerprintOf(verified) !== fingerprint ||
                verifiedButtons.length !== buttons.length ||
                verifiedButtons[0] !== buttons[0]
              ) {
                JobsDiagnostics?.note(
                  "auto_readiness_changed",
                  null,
                  JSON.stringify({
                    fields: verified.rows.length,
                    invalid: verified.invalid.length,
                    errors: verified.errors.length,
                    busy: verified.busy,
                    buttons: verifiedButtons.length,
                  }),
                );
                previous = "";
                since = Date.now();
                continue;
              }
              return { state: verified, button: verifiedButtons[0] };
            }
            return { state: current, button: buttons[0] };
          }
          await new Promise((resolve) =>
            doc.defaultView.setTimeout(resolve, 50),
          );
        }
        if (JobsPageActions.live(canProceed) && root() && visible(root())) {
          const blocked = state({ review });
          JobsDiagnostics?.note(
            "auto_readiness_timeout",
            null,
            JSON.stringify({
              invalid: blocked.invalid.length,
              errors: blocked.errors.length,
              busy: blocked.busy,
              buttons: buttonsNow().length,
            }),
          );
          for (const row of blocked.rows.filter((row) => !complete(row.public)))
            JobsDiagnostics?.note(
              "auto_readiness_field",
              row.node,
              JSON.stringify({
                component: row.public.component,
                reason: completion(row.public),
                required: row.public.required,
                writable: row.public.supported,
              }),
            );
        }
        return null;
      }
      const reader =
        write || JobsControlConfig?.enabled === true
          ? {
              scan,
              read,
              unrecognized,
              response,
              apply,
              readOptions,
              visible,
              state,
              settle,
              pageFailure,
              identify: id,
            }
          : {
              scan,
              read,
              unrecognized,
              response,
              visible,
              state,
              settle,
              pageFailure,
              identify: id,
            };
      commitValues.set(reader, applyValue);
      return reader;
    }
    // Adapters' semantic writes (degree, and any other JobsProfileAnswers spec)
    // share one entrance with the supplement: this control's own options, the
    // shared rule in JobsOptionMatch, an exact write and a verified commit. The
    // decision (options seen, choice, how it matched) goes to the fill trace.
    // Controls whose answer is the text (or date) itself, with no options.
    const textTypes = new Set([
      "text",
      "textarea",
      "email",
      "tel",
      "url",
      "number",
      "date",
      "month",
      "search",
    ]);
    // Literal answers (AI, review, saved exact answers) enter the same matching
    // transaction as Profile specs. Native option IDs are mapped to their labels.
    function literalSpec(node, value, row) {
      row ||= create(
        node.ownerDocument,
        () => node.closest("form,main") || node.ownerDocument,
      )
        .scan()
        .find((item) => item.node === node || item.group?.includes(node));
      const one = (item) => {
        const label =
          typeof item === "boolean"
            ? item
              ? "Yes"
              : "No"
            : (row?.public.options?.find((option) => option.value === item)
                ?.label ?? item);
        const spec =
          JobsProfileAnswers?.knownSpec?.(
            row?.public.question || "",
            label,
            row?.answerContext || {},
          ) || JobsOptionMatch.spec(label);
        return { ...spec, answer: label, literal: true };
      };
      if (Array.isArray(value))
        return {
          ...one(value[0] || ""),
          append: false,
          selections: value.map(one),
        };
      return one(value);
    }
    async function chooseSpec(
      node,
      answer,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
        source = "adapter",
        decider,
        reason,
        timeout,
        onFailure,
      } = /** @type {{canProceed?: () => boolean, replace?: boolean, source?: string, decider?: string, reason?: string, timeout?: number, onFailure?: (error: Error) => void}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      // A control missing on this page, or a fact the Profile does not hold, is
      // simply not written.
      if (!node?.isConnected || !answer || !JobsPageActions.live(canProceed))
        return null;
      const plain =
        node.matches(
          'textarea,input:not([type]),input[type="text"],input[type="email"],input[type="tel"],input[type="url"],input[type="number"]',
        ) &&
        !component(node) &&
        !node.matches('[role="combobox"],[aria-haspopup],[aria-autocomplete]');
      // Adapters may name a field container. Resolve only a single registered
      // component inside that container; never fall through to another field.
      const described = create(
        node.ownerDocument,
        () => node.parentElement || node.ownerDocument,
      )
        .scan()
        .find((row) => row.node === node);
      const grouped = described?.group?.length,
        segmented = !!described?.dateParts;
      if (
        !plain &&
        !grouped &&
        !segmented &&
        !node.matches(
          'select,input[type="radio"],input[type="checkbox"],input[type="date"],input[type="month"]',
        ) &&
        !component(node)
      ) {
        const found = [
          ...new Set(discoverable().flatMap(([, api]) => api.find(node))),
        ].filter((candidate) => node.contains(candidate));
        if (found.length !== 1) return null;
        node = found[0];
      }
      const match = JobsOptionMatch,
        wanted = match.spec(
          typeof answer === "string"
            ? literalSpec(node, answer, described)
            : answer,
        );
      if (!wanted.tiers.length && !Array.isArray(wanted.selections))
        return null;
      const trace = (result, detail = {}) => {
        const observer = create(node.ownerDocument),
          current = observer
            .scan()
            .find((item) => item.node === node || item.group?.includes(node));
        const readback = current
          ? observer.response(current)?.response
          : undefined;
        JobsDiagnostics?.trace?.(node, {
          ...(readback !== undefined ? { readback } : {}),
          source,
          decider,
          reason,
          question: described?.public.question,
          component: described?.public.component,
          topic: wanted.topic || null,
          answer: wanted.selections
            ? wanted.selections.map((item) => match.describe(item)).join("; ")
            : match.describe(wanted),
          result,
          ...detail,
        });
      };
      const pickLabels = (labels) => {
        const choices = (wanted.selections || [wanted]).map((item) =>
          match.pick(labels, item),
        );
        if (
          choices.some((item) => !item) ||
          new Set(choices.map((item) => item.index)).size !== choices.length
        )
          return null;
        return wanted.selections
          ? choices.map((item) => item.label)
          : (choices[0]?.label ?? null);
      };
      // Kept: any existing value unless replaced; with replace, a single committed
      // choice the rule already accepts (a choice shows its committed value).
      const kept = (existing, append) => {
        const satisfied =
          existing.length &&
          (wanted.selections
            ? existing.length === wanted.selections.length &&
              !!pickLabels(existing)
            : match.pick(existing, wanted));
        if (!(
          (existing.length && !replace && (!append || satisfied)) ||
          (replace &&
            !append &&
            satisfied &&
            (wanted.selections || existing.length === 1))
        ))
          return null;
        trace(satisfied ? "kept-existing" : "preserved-existing", {
          chosen: existing.join("; "),
        });
        return !!satisfied;
      };
      const api = component(node)?.api,
        componentType = described?.public.type || api?.describe?.(node)?.type;
      if (
        described?.writable === false ||
        node.matches(":disabled") ||
        api?.describe?.(node)?.disabled
      ) {
        trace("unsupported-control");
        return null;
      }
      if (
        wanted.literal &&
        componentType === "select-multiple" &&
        !Array.isArray(wanted.selections)
      ) {
        trace("unsupported-control");
        return null;
      }
      // A search or other dynamic list matches inside its own transaction: its
      // options exist only once it is opened or searched. A component that takes
      // text, a date or a check has no options and uses the row path below.
      if (
        api &&
        !textTypes.has(componentType) &&
        !["checkbox", "custom-checkbox"].includes(componentType)
      ) {
        if (!api.chooseFrom) {
          trace("unsupported-control");
          return null;
        }
        if (!replace && api.describe?.(node)?.commitState === "unconfirmed") {
          trace("unconfirmed");
          return null;
        }
        const append =
          wanted.append === true &&
          (api.isPrompt?.(node) || api.multiple?.(node));
        api.expect?.(node, wanted);
        const retained = kept(
          [api.value?.(node)].flat().filter((value) => text(value)),
          append,
        );
        if (retained !== null) return retained ? node : null;
        let labels = [],
          picked = null,
          committed = null;
        // A spec may name several search terms (a school tries its full name,
        // campus, then a distinctive word; a source prompt its categories'
        // leaves). Each is searched once; the first the rule picks from is committed.
        for (const term of searchTerms(
          wanted,
          wanted.query ?? wanted.tiers[0]?.[0] ?? "",
        )) {
          committed = await chooseComponent(
            node,
            api,
            (found) => {
              labels = found;
              const selected = pickLabels(found);
              picked =
                selected == null
                  ? null
                  : wanted.selections
                    ? { label: selected.join("; "), method: "exact-options" }
                    : match.last;
              return selected;
            },
            {
              canProceed,
              replace: replace || append,
              append,
              query: term,
              optionSpec: wanted,
              timeout,
            },
          );
          if (committed || picked || !JobsPageActions.live(canProceed)) break;
        }
        const seen = {
          options: labels.slice(0, 60),
          optionCount: labels.length,
        };
        if (!picked) {
          trace(labels.length ? "no-matching-option" : "no-options", {
            ...seen,
            reason: match.last?.reason,
            ambiguous: match.last?.ambiguous,
          });
          return null;
        }
        if (
          committed &&
          create(node.ownerDocument)
            .scan()
            .find((item) => item.node === node)?.public.invalid
        )
          committed = null;
        trace(committed ? "committed" : "not-committed", {
          ...seen,
          chosen: picked.label,
          method: picked.method,
          alias: picked.alias,
          tier: picked.tier,
        });
        return committed ? node : null;
      }
      // Every other field names its own options. The rule picks one, and the
      // field's one setter (reader.apply) writes it: the same setter that writes
      // an AI, review-card or remote answer, which were chosen from this list.
      const reader = create(
        node.ownerDocument,
        () => node.closest("form,main") || node.ownerDocument,
        { write: true },
      );
      const row = reader
        .scan()
        .find((row) => row.node === node || row.group?.includes(node));
      // Independent inputs of one question (Lever's checkboxes share only a name):
      // the rule picks among their captions; each is set with its own primitive.
      const siblings =
        node.matches('input[type="radio"],input[type="checkbox"]') &&
        // A saved answer to one independent checkbox addresses that checkbox,
        // even when the page puts several independent checks in one fieldset.
        !(
          row?.public.type === "checkbox" &&
          !node.name &&
          /^(yes|no|true|false)$/i.test(
            String(wanted.answer ?? wanted.tiers[0]?.[0]),
          )
        ) &&
        !(row?.group?.length > 1)
          ? (node.name
              ? [
                  ...node.ownerDocument.querySelectorAll(
                    'input[type="radio"],input[type="checkbox"]',
                  ),
                ].filter(
                  (other) =>
                    other.name === node.name && other.form === node.form,
                )
              : [
                  ...(
                    node.closest(
                      'fieldset,[role="radiogroup"],[role="group"]',
                    ) || node.parentElement
                  ).querySelectorAll(
                    'input[type="radio"],input[type="checkbox"]',
                  ),
                ]
            ).filter(
              (other) =>
                other.type === node.type && !other.matches(":disabled"),
            )
          : [];
      if (siblings.length > 1) {
        const inputs = siblings;
        const labels = inputs.map((input) => caption(input) || input.value),
          append = wanted.append === true && node.type === "checkbox";
        const retained = kept(
          inputs
            .filter((input) => input.checked)
            .map((input) => caption(input) || input.value),
          append,
        );
        if (retained !== null) return retained ? node : null;
        const picked = match.pick(labels, wanted),
          seen = { options: labels.slice(0, 60), optionCount: labels.length };
        if (!picked) {
          trace("no-matching-option", {
            ...seen,
            reason: match.last?.reason,
            ambiguous: match.last?.ambiguous,
          });
          return null;
        }
        const target = inputs[picked.index];
        if (replace && !append && target.type === "checkbox")
          for (const other of inputs.filter(
            (input) => input !== target && input.checked,
          ))
            if (!(await writeChecked(other, false, { canProceed }))) {
              trace("not-committed", seen);
              return null;
            }
        const committed =
          target.type === "radio"
            ? await writeChoice(target, { canProceed })
            : await writeChecked(target, true, { canProceed });
        trace(committed ? "committed" : "not-committed", {
          ...seen,
          chosen: picked.label,
          method: picked.method,
          alias: picked.alias,
          tier: picked.tier,
        });
        return committed ? node : null;
      }
      if (!row) {
        trace("unsupported-control");
        return null;
      }
      const kind = row.public.type,
        textual = textTypes.has(kind) || !!row.dateParts;
      const options = (row.public.options || []).filter(
        (option) =>
          option.label &&
          !["", "-1", "-999", "resumator_no_selection"].includes(option.value),
      );
      let value, detail;
      if (textual) {
        if (row.public.filled && !replace) {
          const existing =
            reader.response(row)?.response || String(row.raw ?? "");
          const same = !!match.pick([existing], wanted);
          trace(same ? "kept-existing" : "preserved-existing", {
            chosen: existing,
          });
          return same ? node : null;
        }
        value = wanted.answer ?? wanted.tiers[0][0];
        detail = { options: [], method: "literal" };
      } else if (["checkbox", "custom-checkbox"].includes(kind)) {
        const answer = String(wanted.answer ?? wanted.tiers[0][0]);
        if (!/^(yes|no|true|false)$/i.test(answer)) {
          trace("unsupported-control");
          return null;
        }
        if (row.public.filled && !replace) {
          const same = row.raw === /^(yes|true)$/i.test(answer);
          trace(same ? "kept-existing" : "preserved-existing");
          return same ? node : null;
        }
        value = /^(yes|true)$/i.test(answer);
        detail = { method: "literal" };
      } else {
        if (!options.length) {
          trace("no-options");
          return null;
        }
        const multi = kind === "select-multiple",
          append = wanted.append === true && multi,
          selected = multi ? [row.raw || []].flat() : [row.raw];
        const retained = kept(
          options
            .filter((option) => selected.includes(option.value))
            .map((option) => option.label),
          append,
        );
        if (retained !== null) return retained ? node : null;
        const labels = options.map((option) => option.label),
          chosenLabels = pickLabels(labels),
          seen = { options: labels.slice(0, 60), optionCount: labels.length };
        if (chosenLabels == null) {
          trace("no-matching-option", {
            ...seen,
            reason: match.last?.reason,
            ambiguous: match.last?.ambiguous,
          });
          return null;
        }
        const picked = [chosenLabels]
          .flat()
          .map((label) => options.find((option) => option.label === label));
        if (!multi && picked.length !== 1) {
          trace("unsupported-control");
          return null;
        }
        value = multi
          ? append
            ? [
                ...new Set([
                  ...selected,
                  ...picked.map((option) => option.value),
                ]),
              ]
            : picked.map((option) => option.value)
          : picked[0].value;
        detail = {
          ...seen,
          chosen: [chosenLabels].flat().join("; "),
          method: match.last?.method || "exact-options",
          alias: match.last?.alias,
          tier: match.last?.tier,
        };
        if (append) replace = true;
      }
      // The setter records the write, with this match's details.
      try {
        await commitValues.get(reader)(row, value, canProceed, { replace });
        trace("committed", detail);
        return node;
      } catch (error) {
        trace("not-committed", {
          ...detail,
          reason: String(error?.message || error).slice(0, 120),
        });
        onFailure?.(error instanceof Error ? error : new Error(String(error)));
        return null;
      }
    }
    // The terms a component types, one per attempt: the rule's search terms,
    // else its single query.
    const searchTerms = (spec, query) =>
      spec?.queries?.length ? spec.queries : [query];
    // A component's own option transaction for one search term (chooseFrom:
    // open or search once, the rule picks, commit that option). Replacing a
    // multi-select's whole selection reads its finite list once and writes the
    // picked set.
    async function chooseComponent(
      node,
      api,
      pick,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
        append = false,
        query = "",
        optionSpec,
        timeout,
      } = /** @type {{canProceed?: () => boolean, replace?: boolean, append?: boolean, query?: string, optionSpec?: import('./control-types.js').ControlAnswerSpec, timeout?: number}} */ ({}),
    ) {
      return api.chooseFrom(node, pick, {
        canProceed: JobsPageActions.guard(canProceed),
        replace,
        append,
        query,
        optionSpec,
        ...(timeout == null ? {} : { timeout }),
      });
    }
    // All text entrances commit through the same native setter and focus cycle.
    // Allow the framework's input handler to render before blur validates it.
    function writeValue(
      node,
      value,
      {
        change = true,
        keyboard = false,
        click = false,
        onWritten = () => {},
      } = {},
    ) {
      if (!JobsPageActions.allowed()) return null;
      if (!node?.isConnected || node.disabled || node.readOnly || value == null)
        return null;
      const view = node.ownerDocument.defaultView;
      const prototype =
        node.tagName === "TEXTAREA"
          ? view.HTMLTextAreaElement.prototype
          : view.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (!setter) return null;
      if (click) JobsPageActions.click(node);
      node.focus();
      const keys = () => {
        if (keyboard)
          for (const type of ["keydown", "keypress", "keyup"])
            JobsPageActions.dispatch(
              node,
              new view.KeyboardEvent(type, {
                bubbles: true,
                cancelable: false,
              }),
            );
      };
      keys();
      if (node.value === String(value)) node.value = "";
      setter.call(node, String(value));
      onWritten();
      keys();
      JobsPageActions.dispatch(
        node,
        new view.InputEvent("input", {
          bubbles: true,
          composed: true,
          cancelable: true,
          inputType: "insertText",
          data: String(value),
        }),
      );
      if (change)
        JobsPageActions.dispatch(
          node,
          new view.Event("change", { bubbles: true }),
        );
      return node;
    }
    function writeSelect(node, values, { input = true } = {}) {
      if (!JobsPageActions.allowed()) return null;
      if (!node?.isConnected || node.disabled || !node.matches("select"))
        return null;
      if (
        !Array.isArray(values) ||
        values.some(
          (value) =>
            ![...node.options].some(
              (option) => !option.disabled && option.value === value,
            ),
        )
      )
        return null;
      for (const option of node.options)
        option.selected = values.includes(option.value);
      const view = node.ownerDocument.defaultView;
      if (input)
        JobsPageActions.dispatch(
          node,
          new view.Event("input", { bubbles: true }),
        );
      JobsPageActions.dispatch(
        node,
        new view.Event("change", { bubbles: true }),
      );
      const actual = [...node.selectedOptions].map((option) => option.value);
      return actual.length === values.length &&
        actual.every((value) => values.includes(value))
        ? node
        : null;
    }
    async function writeChecked(
      node,
      value,
      { canProceed = /** @type {() => boolean} */ (() => true) } = {},
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (
        !JobsPageActions.live(canProceed) ||
        !node?.isConnected ||
        node.disabled ||
        node.getAttribute("aria-disabled") === "true"
      )
        return null;
      const checked = () =>
        node.matches("input")
          ? node.checked
          : node.getAttribute("aria-checked") === "true";
      if (checked() !== value) JobsPageActions.click(node);
      const accepted = () =>
        JobsPageActions.live(canProceed) &&
        node.isConnected &&
        checked() === value;
      return accepted() ||
        (await JobsDOMWait.until(accepted, {
          root: node.ownerDocument,
          timeout: 1200,
        }))
        ? node
        : null;
    }
    async function writeChoice(
      node,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        attribute = null,
      } = {},
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (
        !JobsPageActions.live(canProceed) ||
        !node?.isConnected ||
        node.disabled ||
        node.getAttribute("aria-disabled") === "true"
      )
        return null;
      const accepted = () =>
        JobsPageActions.live(canProceed) &&
        node.isConnected &&
        (attribute ? node.getAttribute(attribute) === "true" : node.checked);
      if (!accepted()) JobsPageActions.click(node);
      return accepted() ||
        (await JobsDOMWait.until(accepted, {
          root: node.ownerDocument,
          timeout: 1200,
        }))
        ? node
        : null;
    }
    async function writeText(
      node,
      value,
      {
        blur = true,
        canProceed = /** @type {() => boolean} */ (() => true),
        change = true,
        keyboard = false,
        click = false,
        onWritten = /** @type {(node:Element)=>void} */ (() => {}),
        matchesValue = (actual, expected) => actual === expected,
      } = {},
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (
        !node?.isConnected ||
        node.disabled ||
        node.readOnly ||
        value == null ||
        !JobsPageActions.live(canProceed)
      )
        return null;
      const view = node.ownerDocument.defaultView;
      // Focus can be unavailable or redirected by a closing popup. Workday's
      // textarea saves only on React onBlur (native focusout), not input/change.
      // Observe only events after the final value was written; an earlier blur
      // could only have committed the old value.
      let exited = false;
      const onExit = () => {
        exited = true;
      };
      node.addEventListener("focusout", onExit);
      try {
        if (
          !writeValue(node, value, {
            change,
            keyboard,
            click,
            onWritten: () => {
              onWritten(node);
              exited = false;
            },
          })
        )
          return null;
        await new Promise((resolve) => view.setTimeout(resolve, 0));
        if (!node.isConnected || !JobsPageActions.live(canProceed)) return null;
        if (blur) {
          if (node.ownerDocument.activeElement === node) node.blur();
          if (!exited && node.isConnected && JobsPageActions.live(canProceed)) {
            const relatedTarget = node.ownerDocument.activeElement;
            JobsPageActions.dispatch(
              node,
              new view.FocusEvent("blur", { composed: true, relatedTarget }),
            );
            JobsPageActions.dispatch(
              node,
              new view.FocusEvent("focusout", {
                bubbles: true,
                composed: true,
                relatedTarget,
              }),
            );
            JobsDiagnostics?.note(
              "auto_text_commit_fallback",
              node,
              "Native focusout absent after write",
            );
          }
        }
        await new Promise((resolve) => view.setTimeout(resolve, 0));
        if (
          !node.isConnected ||
          !JobsPageActions.live(canProceed) ||
          !matchesValue(node.value, String(value))
        )
          return null;
        return node;
      } finally {
        node.removeEventListener("focusout", onExit);
      }
    }
    function continuation(target) {
      const button = target?.closest?.(
        'button,input[type="submit"],[role="button"]',
      );
      if (
        !button ||
        button.disabled ||
        button.matches('[role="radio"],[role="checkbox"]')
      )
        return null;
      const label = text(
        button.getAttribute("aria-label") || button.value || button.textContent,
      );
      if (/back|previous|cancel|delete|remove|withdraw|later/i.test(label))
        return null;
      return /^(?:next|continue|submit|apply|save (?:and|&) continue|下一步|继续|提交)(?:\b|\s|$)/i.test(
        label,
      )
        ? button
        : null;
    }
    // Reading a committed complex control and knowing how to write it are
    // separate capabilities. All navigation checks share this distinction.
    function completion(field) {
      if (field.invalid) return "invalid";
      if (field.commitState === "unconfirmed") return "unconfirmed";
      if (field.required && !field.filled) return "required-empty";
      if (field.requiredKnown === false) return "unknown-requiredness";
      if (!field.required && !field.filled) return "optional-empty";
      if (field.capabilities?.read === false) return "unreadable";
      if (
        field.completionReadable ||
        field.supported ||
        ["file", "search-choice"].includes(field.type)
      )
        return "filled";
      return "unreadable";
    }
    const complete = (field) =>
      ["filled", "optional-empty"].includes(completion(field));
    const needsAnswer = (field) =>
      (field.required === true || field.optionalSurvey === true) &&
      !field.filled &&
      !field.dependencyBlocked &&
      field.commitState !== "unconfirmed" &&
      field.supported &&
      field.supplement !== false;
    // One read-only question description for first-pass, gap-fill and diagnostics.
    // Site collectors retain their fast locators and option-opening procedures.
    function describeQuestions(
      questions,
      { root } = /** @type {{root?:Document|Element}} */ ({}),
    ) {
      const doc =
        root?.ownerDocument ||
        (root?.nodeType === 9 ? /** @type {Document} */ (root) : null) ||
        (typeof document === "object" ? document : null);
      const anchor = questions.find((item) => item.node)?.node;
      const scope =
        root || anchor?.closest?.("form") || JobsPageSession?.root?.() || doc;
      const rows = doc && scope ? create(doc, () => scope).scan() : [];
      const platform = doc ? JobsPlatformConfig.detect(doc) : {};
      const normalize = (value) =>
        String(value || "")
          .normalize("NFKC")
          .trim()
          .replace(/[\s*✱]+$/g, "")
          .replace(/\s+/g, " ")
          .toLowerCase();
      const country =
        JobsProfileAnswers?.scope(rows.map((row) => row.public)) ||
        JobsProfileAnswers?.scope(questions);
      return questions.map((item) => {
        const anchor = item.node?.control || item.node;
        let matches = anchor
          ? rows.filter(
              (row) =>
                row.node === anchor ||
                anchor.contains?.(row.node) ||
                row.group?.includes(anchor),
            )
          : [];
        if (!matches.length && !anchor)
          matches = rows.filter(
            (row) =>
              normalize(row.public.question) === normalize(item.question),
          );
        const row = matches.length === 1 ? matches[0] : null;
        const label = row?.public.question;
        // A scanner fallback is not stronger evidence than the collector's
        // actual heading. Never replace it with an option or a placeholder.
        const fallbackLabel =
          row &&
          (normalize(label) ===
            normalize(row.node.getAttribute("placeholder")) ||
            (["radio", "custom-radio", "select-multiple"].includes(
              row.public.type,
            ) &&
              row.public.options?.some(
                (option) => normalize(option.label) === normalize(label),
              )));
        const description = row
          ? (row.node.getAttribute("aria-describedby") || "")
              .split(/\s+/)
              .filter(Boolean)
              .map((id) => doc.getElementById(id)?.textContent || "")
              .join(" ")
              .slice(0, 2000)
          : item.description;
        const { node, ...plain } = item;
        // Site facts about this question (signature forms, unresolved follow-up
        // chains, option-matching policy) come from the platform declaration.
        const { optionMatch, ...site } =
          platform.questionContext?.(row, item) || {};
        return {
          ...plain,
          fieldId: item.fieldId || row?.public.id,
          question:
            label &&
            label !== "Unlabelled control" &&
            !(fallbackLabel && item.question)
              ? label
              : item.question,
          type: row?.public.type || item.type,
          inputType: row?.public.type || item.inputType || item.type,
          required: row?.public.required ?? item.required,
          description,
          ...(row?.public.conditional
            ? { conditional: row.public.conditional }
            : {}),
          ...site,
          country: item.country || country || null,
          optionMatch: item.optionMatch || optionMatch,
          options: (item.options ?? row?.public.options)?.map((option) =>
            typeof option === "string" ? option : option.label,
          ),
          ...(matches.length > 1 ? { inputIssue: "ambiguous_control" } : {}),
        };
      });
    }
    // Primitive component operations do not emit answer traces. The shared
    // chooseSpec transaction records the complete answer and final page result.
    JobsControlFields = {
      create,
      beginEntry: (scope) => entryScopes.set(scope, {}),
      entryScope,
      dispose,
      describeQuestions,
      continuation,
      complete,
      completion,
      needsAnswer,
      component,
      chooseSpec,
      literalSpec,
      choiceTypes,
      scans: () => scanned,
      structuralScans: () => structuralScans,
      fieldKey,
      follow,
      writeValue,
      writeText,
      writeChecked,
      writeChoice,
      writeSelect,
      calendarDate,
    };
  })();
}
