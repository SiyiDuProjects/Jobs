import { readWithDependencies } from "./runtime-source.mjs";
import { JSDOM } from "jsdom";
// The Paylocity, Eightfold and TikTok widgets the ATS choice component reads.
export const kinds = [
  "paylocity-dropdown",
  "paylocity-search",
  "eightfold-question",
  "eightfold-combobox",
  "eightfold-choice",
  "tiktok-month",
  "tiktok-dropdown",
  "tiktok-disclosure",
];
const component = await readWithDependencies(
  new URL("../../src/custom/ats-choice-controls.js", import.meta.url),
  "utf8",
);
const domWait = await readWithDependencies(
  new URL("../../src/custom/dom-wait.js", import.meta.url),
  "utf8",
);
const fields = await readWithDependencies(
  new URL("../../src/custom/control-fields.js", import.meta.url),
  "utf8",
);
const rules = await Promise.all(
  ["option-match", "profile-answers", "form-pipeline"].map((name) =>
    readWithDependencies(
      new URL("../../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
const ordinary = ["Daytime", "Nighttime"];
const option = (tag, label, index, attrs = "") =>
  `<${tag} id="option-${index}" ${tag === "button" ? 'type="button"' : ""} ${attrs}>${label}</${tag}>`;
function html(kind, { multi = false, virtualComplete = true } = {}) {
  if (kind === "paylocity-dropdown")
    return `<div id="info.schedule" role="combobox" aria-label="Preferred schedule*" aria-required="true" aria-expanded="false"><span class="selected-value"></span><ul>${ordinary.map((label, index) => option("li", label, index)).join("")}</ul></div>`;
  if (kind === "paylocity-search")
    return `<div id="control" data-automation-id="public-site-address-country-input-base" aria-label="Country*" aria-required="true" aria-expanded="false"><span class="selected-value"></span><input id="search"></div><div id="public-site-address-country-dropdown-list-container">${ordinary.map((label, index) => option("div", label, index, 'class="ListItemEven"')).join("")}</div>`;
  if (kind === "eightfold-question")
    return `<div id="question" class="body-question-label">Preferred schedule*</div><div><div class="select-module"><input id="control" role="combobox" aria-label="Preferred schedule*" aria-required="true" aria-expanded="false" readonly></div><ul>${ordinary.map((label, index) => `<li>${option("button", label, index)}</li>`).join("")}</ul></div>`;
  if (kind === "eightfold-combobox")
    return `<div id="container" data-test-id="country"><input id="control" role="combobox" aria-label="Country*" aria-required="true" aria-expanded="false" readonly><ul role="listbox">${ordinary.map((label, index) => `<li>${option("button", label, index, 'role="option"')}</li>`).join("")}</ul></div>`;
  if (kind === "eightfold-choice")
    return `<div id="question" class="body-question-label">Preferred schedule*</div><div><div id="control" class="checkBoxGroup" ${multi ? "" : 'role="radiogroup"'} aria-label="Preferred schedule*" aria-required="true">${ordinary.map((label, index) => `<div><input id="choice-${index}" name="choice" type="${multi ? "checkbox" : "radio"}" style="display:none"><label id="option-${index}" for="choice-${index}">${label}</label></div>`).join("")}</div></div>`;
  if (kind === "tiktok-month")
    return `<label>Education</label><div class="atsx-date-picker"><div id="control" class="atsx-date-picker-period-month-label" aria-label="Start month*" aria-required="true">Start date</div><div id="month-end" class="atsx-date-picker-period-month-label" aria-label="End month (optional)" aria-required="false">End date</div></div><div id="popup" class="atsx-date-picker-dropdown atsx-date-picker-dropdown-hidden"><div class="scrollbar-container"><div id="year" data-cy="2027">2027</div></div><div class="scrollbar-container"><div id="month" data-cy="05">May</div></div></div>`;
  if (kind === "tiktok-dropdown")
    return `<div id="control" class="atsx-select" aria-label="Degree*" aria-required="true" aria-expanded="false"><span class="atsx-select-selection-item"></span></div><div id="popup" class="atsx-select-dropdown atsx-select-dropdown-hidden"><ul>${ordinary.map((label, index) => `<li>${option("span", label, index, `data-cy-value="${label}"`)}</li>`).join("")}</ul></div>`;
  if (kind === "tiktok-disclosure")
    return `<div id="control" class="ud__select__selector" aria-label="Preferred schedule*" aria-required="true" aria-expanded="false"><span class="ud__select__selection-item"></span></div><div><div id="popup" class="ud__select__dropdown ud__select__dropdown-hidden"><div class="rc-virtual-list-holder-inner">${ordinary.map((label, index) => option("div", `<span>${label}</span>`, index, `class="ud__select__list__item" ${virtualComplete ? `aria-setsize="2" aria-posinset="${index + 1}"` : ""}`)).join("")}</div></div></div>`;
  throw Error(kind);
}
export async function fixture(
  kind,
  {
    missing = false,
    uncommitted = false,
    retry = false,
    multi = false,
    virtualComplete = true,
  } = {},
) {
  const dom = new JSDOM(
    `<form>${html(kind, { multi, virtualComplete })}</form><main></main>`,
    { url: "https://fixture.eightfold.ai/careers", runScripts: "outside-only" },
  );
  const w = dom.window,
    doc = w.document,
    trace = [],
    root = doc.querySelector("form");
  const control = doc.getElementById(
    kind === "paylocity-dropdown" ? "info.schedule" : "control",
  );
  const find = (query, base = doc) => all(query, base)[0] || null;
  const all = (query, base = doc) => {
    const result = doc.evaluate(
      query,
      base,
      null,
      w.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    return Array.from({ length: result.snapshotLength }, (_, index) =>
      result.snapshotItem(index),
    );
  };
  const events = [
    "mouseover",
    "mousedown",
    "mouseup",
    "click",
    "input",
    "change",
    "keydown",
  ];
  for (const type of events)
    doc.addEventListener(
      type,
      (event) => {
        if (event.target.id)
          trace.push(["event", type, event.target.id, event.key || ""]);
      },
      true,
    );
  const popup = doc.getElementById("popup");
  control.onclick = (event) => {
    if (event.target !== control) return;
    control.setAttribute("aria-expanded", "true");
    if (popup)
      popup.className = popup.className.replace(
        /\s*(atsx-date-picker-dropdown-hidden|atsx-select-dropdown-hidden|ud__select__dropdown-hidden)/g,
        "",
      );
  };
  control.onkeydown = (event) => {
    if (event.key === "Escape") control.setAttribute("aria-expanded", "false");
  };
  for (const item of doc.querySelectorAll('[id^="option-"]'))
    item.onclick = () => {
      if (uncommitted || kind === "eightfold-choice") return;
      const label = item.textContent;
      if (control.matches("input")) control.value = label;
      else {
        const display = control.querySelector(
          ".selected-value,.atsx-select-selection-item,.ud__select__selection-item",
        );
        if (display) display.textContent = label;
      }
      control.setAttribute("aria-expanded", "false");
      item.setAttribute("aria-selected", "true");
    };
  if (kind === "tiktok-month")
    doc.getElementById("month").onclick = () => {
      if (!uncommitted) control.textContent = "2027-05";
    };
  const click = (selector, useXPath = false) => {
    trace.push(["click", selector, useXPath]);
    const node = useXPath ? find(selector) : doc.querySelector(selector);
    node?.click();
    return node;
  };
  Object.assign(w, {
    jobsFindXPath: find,
    jobsFindAllXPath: all,
    jobsClick: click,
    jobsWaitForCssNodes: async (selector) => {
      trace.push(["waitCss", selector]);
      return [...doc.querySelectorAll(selector)];
    },
    jobsWaitForXPathNodes: async (query) => {
      trace.push(["waitXPath", query]);
      return all(query);
    },
    jobsWaitForXPathNodesWithRetry: async (query, delay, attempts, onRetry) => {
      trace.push(["retry", query, delay, attempts]);
      if (retry) onRetry?.();
      return all(query);
    },
  });
  w.eval(domWait);
  w.eval(fields);
  w.eval(component);
  for (const code of rules) w.eval(code);
  if (missing) {
    if (kind === "eightfold-choice")
      doc.querySelectorAll('[id^="choice-"]').forEach((node) => node.remove());
    else control.remove();
  }
  const reader = w.JobsControlFields.create(doc, () => root, { write: true });
  return {
    w,
    doc,
    root,
    control,
    trace,
    reader,
    api: w.JobsATSChoiceControls,
    close: () => w.close(),
  };
}
