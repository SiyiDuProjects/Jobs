import { readWithDependencies } from "./runtime-source.mjs";
import { JSDOM } from "jsdom";
const root = new URL("../../", import.meta.url);
const read = (path) => readWithDependencies(new URL(path, root), "utf8");
const sources = await Promise.all(
  [
    "src/custom/dom-wait.js",
    "src/custom/option-match.js",
    "src/custom/profile-answers.js",
    "src/custom/control-fields.js",
    "src/custom/form-pipeline.js",
    "src/custom/ashby-controls.js",
    "src/custom/legacy-select-controls.js",
    "src/custom/tag-controls.js",
    "source/content/shared/dom-controls.js",
    "source/content/shared/answer-helpers.js",
    "source/content/shared/profile-format.js",
  ].map(read),
);

// The real controls, pipeline and shared page helpers in a fixture page.
export function installLegacyFixtureLibraries(window) {
  for (const source of sources) window.eval(source);
}

const hosts = {
  pinpoint: "company.pinpointhq.com",
  rippling: "ats.rippling.com",
  "rippling-legacy": "company.rippling-ats.com",
  "rippling-location": "ats.rippling.com",
  greenhouse: "boards.greenhouse.io",
  "greenhouse-location": "boards.greenhouse.io",
  ashby: "jobs.ashbyhq.com",
  lever: "jobs.lever.co",
  seek: "www.seek.com.au",
};
const markup = {
  pinpoint:
    '<label>Country</label><div id="field"><div class="react-select__control" aria-required="true"><div class="react-select__placeholder">Select</div><input></div></div>',
  rippling:
    '<label>Gender</label><div id="field" data-testid="eeoc.gender"><input role="combobox" aria-required="true"></div>',
  "rippling-legacy":
    '<label id="user.country_label">Country</label><div id="field" class="Select"><input id="user.country" aria-required="true"></div>',
  "rippling-location":
    '<label>Location</label><div id="field" data-testid="location"><input aria-required="true"></div>',
  greenhouse:
    '<label>School</label><div id="field" class="select2-container"><span class="select2-chosen"></span><input id="school" aria-required="true"></div>',
  "greenhouse-location":
    '<label for="auto_complete_input">Location</label><div id="field"><input id="auto_complete_input" aria-required="true"></div>',
  ashby:
    '<label for="_systemfield_location">Location</label><input id="_systemfield_location" role="combobox" aria-haspopup="listbox" aria-required="true" aria-controls="location-options">',
  lever:
    '<label>Location</label><input name="location" aria-required="true"><div><div class="dropdown-results"></div></div>',
  seek: '<label>Location</label><div id="field"><input data-automation="current-location2" aria-required="true"></div>',
};

export function legacySelectFixture(
  kind,
  {
    options = ["California North", "California"],
    delay = 0,
    committed = true,
    initial = "",
    preselected = "",
    includeLeverWrapper = true,
  } = {},
) {
  const dom = new JSDOM(
    '<!doctype html><form class="application-field">' +
      markup[kind] +
      "</form>",
    { url: "https://" + hosts[kind] + "/apply", runScripts: "outside-only" },
  );
  const { window } = dom,
    doc = window.document,
    form = doc.querySelector("form"),
    input = doc.querySelector("input");
  const canonical =
    kind === "pinpoint" ? doc.querySelector(".react-select__control") : input;
  const events = [],
    timers = new Set();
  input.value = initial;
  if (!includeLeverWrapper)
    doc.querySelector(".dropdown-results")?.parentElement.remove();
  let popup;
  function recordEvent(event) {
    const option = event.target.closest?.("[data-fixture-option]");
    const source = option
      ? "option:" + option.textContent
      : event.target === input
        ? "input"
        : event.target.id === "school_search"
          ? "search"
          : event.target.classList?.contains("react-select__placeholder")
            ? "placeholder"
            : null;
    if (source)
      events.push(
        `${source}:${event.type}${event.type.startsWith("key") ? ":" + event.key : ""}`,
      );
  }
  for (const event of [
    "mouseover",
    "mousedown",
    "mouseup",
    "click",
    "focus",
    "blur",
    "focusout",
    "input",
    "change",
    "keydown",
    "keypress",
    "keyup",
  ])
    doc.addEventListener(event, recordEvent, true);
  function addOptions() {
    if (!popup || (popup.childElementCount && kind !== "greenhouse")) return;
    for (const item of options) {
      const label = typeof item === "string" ? item : item.label;
      const option = doc.createElement(
        [
          "rippling",
          "rippling-location",
          "greenhouse",
          "greenhouse-location",
          "seek",
        ].includes(kind)
          ? "li"
          : "div",
      );
      option.dataset.fixtureOption = "true";
      if (kind === "greenhouse-location")
        option.dataset.index = String(popup.childElementCount);
      if (kind === "pinpoint") option.className = "react-select__option";
      if (kind === "greenhouse") {
        option.setAttribute("role", "option");
        const span = doc.createElement("span");
        span.textContent = label;
        option.append(span);
      } else {
        option.textContent = label;
        if (kind === "ashby" || kind === "rippling-legacy")
          option.setAttribute("role", "option");
      }
      if (item.disabled) option.setAttribute("aria-disabled", "true");
      option.addEventListener("click", () => {
        if (!committed) return;
        input.value = label;
        input.setAttribute("aria-expanded", "false");
        for (const other of popup.querySelectorAll('[aria-selected="true"]'))
          other.removeAttribute("aria-selected");
        option.setAttribute("aria-selected", "true");
        if (kind === "pinpoint") {
          const current = canonical.querySelector(
            ".react-select__placeholder,.react-select__single-value",
          );
          current.className = "react-select__single-value";
          current.textContent = label;
        }
        if (kind === "rippling-legacy") {
          let selected = doc.querySelector(".Select-value-label");
          if (!selected) {
            selected = doc.createElement("span");
            selected.className = "Select-value-label";
            doc.getElementById("field").append(selected);
          }
          selected.textContent = label;
        }
        if (kind === "greenhouse")
          doc.querySelector(".select2-chosen").textContent = label;
        popup.hidden = true;
      });
      popup.append(option);
    }
  }
  function open() {
    if (popup) {
      popup.hidden = false;
      return;
    }
    input.setAttribute("aria-expanded", "true");
    if (kind === "lever") popup = doc.querySelector(".dropdown-results");
    else {
      popup = doc.createElement(
        [
          "rippling",
          "rippling-location",
          "greenhouse-location",
          "seek",
        ].includes(kind)
          ? "ul"
          : "div",
      );
      if (kind === "greenhouse-location")
        popup.id = "location_autocomplete-items-popup";
      if (kind === "pinpoint") popup.className = "react-select__menu";
      if (kind === "rippling-legacy") {
        const outer = doc.createElement("div");
        outer.className = "Select-menu-outer";
        popup.setAttribute("role", "listbox");
        outer.append(popup);
        doc.getElementById("field").append(outer);
      } else if (kind === "greenhouse") {
        popup.className = "select2-drop";
        const search = doc.createElement("input");
        search.id = "school_search";
        popup.append(search);
        doc.body.append(popup);
      } else if (kind === "ashby") {
        popup.id = "location-options";
        popup.setAttribute("role", "listbox");
        form.append(popup);
      } else doc.getElementById("field").append(popup);
    }
    if (!popup) return;
    if (delay) {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        addOptions();
      }, delay);
      timers.add(timer);
    } else addOptions();
  }
  if (kind === "pinpoint")
    canonical
      .querySelector(".react-select__placeholder")
      .addEventListener("click", open);
  else if (kind === "rippling-legacy")
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") open();
    });
  else input.addEventListener("input", open);
  if (preselected) {
    input.value = preselected;
    if (kind === "pinpoint") {
      const selected = canonical.querySelector(".react-select__placeholder");
      selected.className = "react-select__single-value";
      selected.textContent = preselected;
      selected.addEventListener("click", open);
    }
    if (kind === "rippling-legacy") {
      const selected = doc.createElement("span");
      selected.className = "Select-value-label";
      selected.textContent = preselected;
      doc.getElementById("field").append(selected);
    }
    if (kind === "greenhouse")
      doc.querySelector(".select2-chosen").textContent = preselected;
  }
  installLegacyFixtureLibraries(window);
  const profile = {
    nameData: { firstName: "A", lastName: "B" },
    contactData: { email: "test@example.invalid", phoneNumber: "123" },
    jobData: [],
    addressData: { city: "California", state: "CA", country: "United States" },
  };
  return {
    window,
    doc,
    input,
    canonical,
    events,
    open,
    profile,
    controls: window.JobsLegacySelectControls,
    reader: window.JobsControlFields.create(doc, () => form, { write: true }),
    close() {
      for (const timer of timers) window.clearTimeout(timer);
      window.close();
    },
  };
}
