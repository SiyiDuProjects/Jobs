import { JobsControlFields } from "./control-fields.js";
import { JobsPageActions } from "./page-actions.js";
import { JobsDiagnostics } from "./diagnostics.js";
export var JobsAshbySavedControls;
let initialized = false;
export function initializeAshbySavedControls() {
  if (initialized) return;
  initialized = true;
  const states = new WeakMap();
  const queues = new WeakMap(),
    blocked = new WeakMap();
  async function transaction(node, run, canProceed = () => true) {
    const doc = node.ownerDocument;
    const previous = queues.get(doc);
    let release;
    queues.set(
      doc,
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await previous;
    try {
      const pending = blocked.get(doc);
      if (pending && !(await verify(pending, { canProceed }))) return false;
      blocked.delete(doc);
      const ok = await run();
      if (!ok && value(node)) blocked.set(doc, node);
      return ok;
    } finally {
      release();
    }
  }
  const isControl = (node) =>
    node?.ownerDocument.location.hostname === "jobs.ashbyhq.com" &&
    !!node.closest("[data-field-path]") &&
    !node.closest(".ashby-application-form-input-education-entry") &&
    node.matches(
      'input:not([role="combobox"]):is([type="text"],[type="email"],[type="url"],[type="tel"],:not([type])),textarea,.ashby-application-form-input-yesno',
    );
  const buttons = (node) => [...node.querySelectorAll("button[data-option]")];
  const isChoice = (node) =>
    node.matches(".ashby-application-form-input-yesno");
  const value = (node) =>
    node.matches('input[type="file"]')
      ? node.files?.[0]?.name || ""
      : isChoice(node)
        ? buttons(node)
            .find((button) => button.getAttribute("aria-pressed") === "true")
            ?.textContent.trim() || ""
        : node.value;
  async function verify(
    node,
    {
      canProceed = /** @type {() => boolean} */ (() => true),
      phase = "saved",
    } = {},
  ) {
    if (phase !== "upload-start" && !value(node)) return true;
    const before = value(node),
      url = node.ownerDocument.location.href;
    let result;
    try {
      result = (
        await chrome.runtime.sendMessage({
          type: "jobs:ashby-commit",
          path: node
            .closest("[data-field-path]")
            .getAttribute("data-field-path"),
          phase,
        })
      )?.data;
    } catch {
      result = { state: "unavailable" };
    }
    const ok =
      result?.state === "confirmed" &&
      node.isConnected &&
      node.ownerDocument.location.href === url &&
      value(node) === before &&
      JobsPageActions.live(canProceed);
    if (phase === "saved" || !ok) states.set(node, { value: before, ok });
    JobsDiagnostics?.note(
      "auto_saved_value_check",
      node,
      JSON.stringify({
        phase,
        state: result?.state || "unavailable",
        confirmed: ok,
      }),
    );
    return ok;
  }
  JobsAshbySavedControls = {
    isControl,
    value,
    readOptions(node, canProceed = () => true) {
      if (
        !isChoice(node) ||
        !node.isConnected ||
        !JobsPageActions.live(canProceed)
      )
        return [];
      return buttons(node).map((button) => ({
        label: button.textContent.trim(),
        value: button.textContent.trim(),
      }));
    },
    facts(node) {
      const held = value(node),
        state = states.get(node);
      return {
        type: isChoice(node) ? "yesno" : node.type || "text",
        value: held,
        supported: true,
        readable: true,
        ...(isChoice(node)
          ? {
              options: buttons(node).map((button) => ({
                label: button.textContent.trim(),
                value: button.textContent.trim(),
              })),
            }
          : {}),
        ...(state && (!state.ok || state.value !== held)
          ? { commitState: "unconfirmed" }
          : {}),
      };
    },
    verify,
    async upload(node, run) {
      if (!node.closest("[data-field-path]"))
        return { hold: "Attachment save cannot be verified" };
      if (
        await transaction(node, async () => {
          if (!(await verify(node, { phase: "upload-start" }))) return false;
          if (!JobsPageActions.allowed()) return false;
          run();
          return verify(node);
        })
      )
        return;
      return { hold: "Attachment save not confirmed" };
    },
    async chooseFrom(node, pick, { canProceed = () => true } = {}) {
      canProceed = JobsPageActions.guard(canProceed);
      return transaction(
        node,
        () => choose(node, pick, canProceed),
        canProceed,
      );
    },
  };
  async function choose(node, pick, canProceed) {
    if (!JobsPageActions.live(canProceed)) return false;
    let written;
    if (isChoice(node)) {
      const options = buttons(node),
        selected = pick(options.map((button) => button.textContent.trim()));
      const matches = options.filter(
        (button) => button.textContent.trim() === selected,
      );
      if (matches.length !== 1) return false;
      written = await JobsControlFields.writeChoice(matches[0], {
        canProceed,
        attribute: "aria-pressed",
      });
    } else {
      const answer = pick([]);
      written = await JobsControlFields.writeText(node, answer, {
        canProceed,
        beforeBlur: () => verify(node, { canProceed, phase: "draft" }),
      });
    }
    return !!written && (await verify(node, { canProceed }));
  }
}
