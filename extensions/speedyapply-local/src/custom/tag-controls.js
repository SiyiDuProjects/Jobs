import { JobsPageActions } from "./page-actions.js";
import { JobsDiagnostics } from "./diagnostics.js";
import { JobsControlFields } from "./control-fields.js";
import { JobsDOMWait } from "./dom-wait.js";

export var JobsTagControls;
let initialized = false;
export function initializeTagControls() {
  if (initialized) return;
  initialized = true;
  // Seek and UltiPro skill lists. Page adapters own opening/saving; adding a tag
  // and reading its actual list entry are shared with AI and remote operations.
  (() => {
    const states = new WeakMap();
    const text = (value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const lower = (value) => text(value).toLowerCase();
    const ultiRegion = `//h2[contains(text(),'Skills')]/../../following-sibling::div`;
    const allXp = (doc, path) => {
      const result = doc.evaluate(
        path,
        doc,
        null,
        doc.defaultView.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );
      return Array.from({ length: result.snapshotLength }, (_, index) =>
        result.snapshotItem(index),
      );
    };
    function info(node) {
      if (!node?.matches) return null;
      const doc = node.ownerDocument,
        host = doc.location.hostname;
      if (/(^|\.)seek\.com\.au$/.test(host)) {
        const drawer = doc.querySelector(
          '[data-automation="skills-form-drawer"]',
        );
        if (node === drawer)
          return {
            kind: "seek",
            input: node.querySelector(
              'input[data-automation="skills-tags-input"]',
            ),
            add: node.querySelector('[data-automation="add-skill-button"]'),
            list: node.querySelector('[data-testid="added-skills"] ul'),
            editing: true,
          };
        if (!drawer && node.matches('[data-automation="skill-section"]'))
          return {
            kind: "seek",
            list: node.querySelector("ul"),
            editing: false,
          };
      }
      if (
        /(^|\.)ultipro\.(com|ca)$/.test(host) &&
        allXp(doc, ultiRegion).includes(node) &&
        (node.hasAttribute("aria-expanded") ||
          node.querySelector('ul.listtype,input[aria-label="Skills"]'))
      )
        return {
          kind: "ultipro",
          input: node.querySelector('input[aria-label="Skills"]'),
          add: node.querySelector('[data-automation="item-add-button"]'),
          list: node.querySelector("ul.listtype"),
          editing: node.getAttribute("aria-expanded") === "true",
        };
      return null;
    }
    const isControl = (node) => !!info(node);
    function find(scope) {
      if (!scope) return [];
      const doc = scope.ownerDocument || scope;
      const nodes = [
        ...scope.querySelectorAll(
          '[data-automation="skills-form-drawer"],[data-automation="skill-section"]',
        ),
        ...allXp(doc, ultiRegion).filter(
          (node) => scope === doc || scope.contains(node),
        ),
      ];
      if (isControl(scope)) nodes.unshift(scope);
      return [...new Set(nodes.filter(isControl))];
    }
    function label(item) {
      const copy = item.cloneNode(true);
      copy
        .querySelectorAll('button,svg,input,[aria-hidden="true"]')
        .forEach((node) => node.remove());
      return text(copy.textContent);
    }
    function value(node) {
      return [...(info(node)?.list?.querySelectorAll(":scope > li") || [])]
        .map(label)
        .filter(Boolean);
    }
    function record(node) {
      if (!states.has(node)) {
        const entry = { revision: 0, writing: 0 };
        node.addEventListener("input", () => {
          if (!entry.writing) {
            entry.revision++;
            entry.query = undefined;
            entry.pending = [];
          }
        });
        states.set(node, entry);
      }
      return states.get(node);
    }
    function describe(node) {
      const details = info(node);
      if (!details) return null;
      const entry = record(node),
        controls = [node, details.input].filter(Boolean);
      const selected = value(node);
      entry.pending = (entry.pending || []).filter(
        (attempt) =>
          attempt.input === details.input &&
          attempt.url === node.ownerDocument.location.href &&
          !selected.some((label) => lower(label) === lower(attempt.answer)),
      );
      const required = controls.some(
        (item) =>
          item.hasAttribute("required") ||
          item.getAttribute("aria-required") === "true",
      );
      const requiredKnown =
        required ||
        controls.some((item) => item.getAttribute("aria-required") === "false");
      const disabled = controls.some(
        (item) =>
          item.disabled || item.getAttribute("aria-disabled") === "true",
      );
      return {
        type: "select-multiple",
        component: details.kind + "-skills",
        question: "Skills",
        value: selected,
        required,
        requiredKnown,
        readable: !!details.list,
        supported: !!(details.editing && details.input && details.add),
        disabled,
        invalid: controls.some(
          (item) => item.getAttribute("aria-invalid") === "true",
        ),
        commitState:
          entry.pending.length ||
          (details.input?.value && details.input.value !== entry.query)
            ? "unconfirmed"
            : undefined,
        group: [node, ...node.querySelectorAll("input,button")],
        options: cachedOptions(node),
      };
    }
    function cachedOptions(node) {
      return states.get(node)?.options;
    }
    async function readOptions(
      node,
      canProceed = /** @type {() => boolean} */ (() => true),
      context = {},
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (!JobsPageActions.live(canProceed) || !info(node)) return [];
      const existing = value(node),
        supplied = Array.isArray(context.answers) ? context.answers : [];
      // These are free-text tags. Only actual tags and the rule's answers (the
      // Profile skills) are offered as candidates; there is no invented dropdown menu.
      const labels = [
        ...new Set(
          [...existing, ...supplied]
            .filter((item) => typeof item === "string" && text(item))
            .map(text),
        ),
      ];
      const options = labels.map((label) => ({ value: label, label }));
      record(node).options = options;
      return options;
    }
    function click(node) {
      if (!node) return null;
      const run = () => {
        JobsPageActions.click(node);
        return node;
      };
      return JobsDiagnostics?.perform
        ? JobsDiagnostics.perform("click", () => node, run)
        : run();
    }
    function write(input, answer, entry, current) {
      entry.writing++;
      const run = () =>
        JobsControlFields.writeText(input, answer, {
          keyboard: true,
          click: true,
          canProceed: current,
        });
      const result = JobsDiagnostics?.perform
        ? JobsDiagnostics.perform("text", () => input, run)
        : run();
      entry.query = input?.value;
      return Promise.resolve(result).finally(() => {
        entry.writing--;
      });
    }
    async function add(
      node,
      answer,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        timeout = 3000,
      } = {},
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      const details = info(node);
      if (!details?.editing || !details.input || !details.add) return null;
      const entry = record(node),
        doc = node.ownerDocument,
        url = doc.location.href,
        revision = ++entry.revision;
      const current = () =>
        JobsPageActions.live(canProceed) &&
        node.isConnected &&
        info(node)?.input === details.input &&
        entry.revision === revision &&
        doc.location.href === url &&
        !node.closest('[hidden],[inert],[aria-hidden="true"]') &&
        !details.input.disabled &&
        !details.add.disabled &&
        details.input.getAttribute("aria-disabled") !== "true" &&
        details.add.getAttribute("aria-disabled") !== "true";
      if (!current()) return null;
      const matches = () =>
        value(node).some((label) => lower(label) === lower(answer));
      if (!(await write(details.input, answer, entry, current)) || !current())
        return null;
      entry.writing++;
      try {
        click(details.add);
      } finally {
        entry.writing--;
      }
      if (!matches())
        (entry.pending ||= []).push({ input: details.input, url, answer });
      const accepted = await JobsDOMWait.until(
        () => (current() ? matches() : { cancelled: true }),
        { root: doc, timeout },
      );
      if (!accepted || accepted.cancelled || !current()) return null;
      JobsDiagnostics?.note("auto_tag_committed", node, details.kind);
      return { added: true, node };
    }
    async function chooseUntraced(
      node,
      answers,
      {
        canProceed = /** @type {() => boolean} */ (() => true),
        replace = false,
        timeout = 3000,
      } = /** @type {{canProceed?: () => boolean, replace?: boolean, timeout?: number}} */ ({}),
    ) {
      canProceed = JobsPageActions.guard(canProceed);
      if (
        !Array.isArray(answers) ||
        answers.some((answer) => typeof answer !== "string" || !text(answer)) ||
        new Set(answers.map(lower)).size !== answers.length ||
        !JobsPageActions.live(canProceed)
      )
        return null;
      const details = info(node);
      if (!details?.editing || !details.list || !details.input || !details.add)
        return null;
      const existing = value(node),
        desired = answers.map(text);
      if (describe(node).commitState === "unconfirmed" && !replace) return null;
      // Removal controls have not been observed; refuse requests requiring any
      // deletion instead of silently retaining extra tags or guessing remove UI.
      if (
        existing.some(
          (item) => !desired.some((answer) => lower(answer) === lower(item)),
        )
      )
        return null;
      for (const answer of desired)
        if (!value(node).some((item) => lower(item) === lower(answer))) {
          if (!(await add(node, answer, { canProceed, timeout }))) return null;
        }
      const actual = value(node);
      return JobsPageActions.live(canProceed) &&
        actual.length === desired.length &&
        actual.every((item) =>
          desired.some((answer) => lower(item) === lower(answer)),
        ) &&
        !describe(node).invalid
        ? node
        : null;
    }
    // Free-text tags: the rule's answer is its own option. It is offered as the
    // only candidate and added when the rule accepts it.

    // Every entrance (a binding, a known answer, AI, remote review)
    // ends here: record what was asked and what the control holds afterwards.

    // The only public component transaction. Selection belongs to the caller;
    // this component exposes page facts, commits the selection and reads it back.
    async function chooseFrom(node, pick, options = {}) {
      const answers = options.optionSpec?.selections?.map(
        (item) => item.answer ?? item.tiers[0]?.[0],
      ) || [options.query];
      const available = await readOptions(node, options.canProceed, {
        answers,
      });
      const selected = pick(available.map((item) => item.label));
      if (selected == null) return null;
      const desired = options.append
        ? [...new Set([...value(node), ...[selected].flat()])]
        : [selected].flat();
      return chooseUntraced(node, desired, options);
    }
    JobsTagControls = Object.freeze({
      find,
      isControl,
      describe,
      value,
      cachedOptions,
      readOptions,
      chooseFrom,
      multiple: isControl,
    });
  })();
}
