import { readWithDependencies } from "./runtime-source.mjs";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
export { functionBlock } from "./module-source.mjs";

const modules = await Promise.all(
  [
    "dom-wait",
    "option-match",
    "profile-answers",
    "control-fields",
    "menu-controls",
    "form-pipeline",
  ].map((name) =>
    readWithDependencies(
      new URL("../../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
// A menu widget (ADP, BambooHR, Dayforce) in a page with the real menu
// component. The adapter functions under test are loaded by the test.
export function menuFixture(
  type,
  {
    labels = ["Alpha", "Beta"],
    delay = 0,
    commit = true,
    nativeBacking = true,
    readOnly = false,
    required = false,
    labelledOptional = false,
    waitTimeout = 180,
  } = {},
) {
  const documentUrl = {
    adp: "https://workforcenow.adp.com/mascsr/apply",
    bamboohr: "https://fixture.bamboohr.com/careers/1",
    dayforce: "https://fixture.dayforcehcm.com/apply",
  }[type];
  const field = (
    id,
  ) => `<div class="field" id="${id}-field"><label for="${id}-native">${id === "target" ? "Question" : "Other question"}${required ? "*" : labelledOptional ? " (optional)" : ""}</label>
    ${
      type === "adp"
        ? `<div class="input-container" id="${id}"><input role="combobox" aria-controls="${id}-menu"></div>`
        : type === "bamboohr"
          ? `<div id="${id}-container"><button id="${id}" aria-haspopup="true" data-menu-id="${id}-menu">Choose</button></div>`
          : `<div class="ant-select"><input id="${id}" role="combobox" aria-controls="${id}-menu" ${readOnly ? "readonly" : ""}></div>`
    }
    ${nativeBacking ? `<select id="${id}-native" style="display:none" ${required ? "required" : ""}><option value="">Choose</option></select>` : ""}</div>`;
  const dom = new JSDOM(
    "<form>" + field("target") + field("other") + "</form>",
    { url: documentUrl, runScripts: "outside-only" },
  );
  const w = dom.window,
    doc = w.document,
    node = doc.getElementById("target"),
    trace = [],
    waits = [],
    diagnostics = [];
  for (const code of modules) w.eval(code);
  const originalUntil = w.JobsDOMWait.until;
  w.JobsDOMWait.until = (read, options = {}) =>
    originalUntil(read, { ...options, timeout: waitTimeout });
  w.JobsDiagnostics = {
    note: (type, element, detail) => diagnostics.push({ type, detail }),
  };
  function popup(id, choices) {
    let menu = doc.getElementById(id + "-menu");
    if (!menu) {
      menu = doc.createElement("div");
      menu.id = id + "-menu";
      menu.setAttribute("role", type === "bamboohr" ? "menu" : "listbox");
      menu.className = "menu-list";
      doc.body.append(menu);
    }
    menu.hidden = false;
    menu.replaceChildren(
      ...choices.map((label) => {
        const option = doc.createElement("div");
        option.setAttribute(
          "role",
          type === "bamboohr" ? "menuitem" : "option",
        );
        option.textContent = label;
        for (const event of ["mouseover", "mousedown", "mouseup", "click"])
          option.addEventListener(event, () => {
            trace.push(id + ":option:" + event + ":" + label);
            if (event !== "click" || !commit || id !== "target") return;
            const select = doc.getElementById(id + "-native"),
              trigger = doc.getElementById(id);
            if (select) {
              select.replaceChildren(new w.Option(label, label, true, true));
              select.dispatchEvent(new w.Event("change", { bubbles: true }));
            } else if (trigger.matches("input[readonly]"))
              trigger.value = label;
            else {
              const marker = doc.createElement("span");
              marker.className =
                type === "dayforce"
                  ? "ant-select-selection-item"
                  : "select__single-value";
              marker.textContent = label;
              (type === "adp" ? trigger : trigger.parentElement).append(marker);
            }
            menu.hidden = true;
          });
        return option;
      }),
    );
    return menu;
  }
  function show(id) {
    if (delay) w.setTimeout(() => popup(id, labels), delay);
    else popup(id, labels);
  }
  for (const id of ["target", "other"]) {
    const target = doc.getElementById(id);
    for (const event of [
      "focus",
      "mouseover",
      "mousedown",
      "mouseup",
      "click",
      "keydown",
      "keypress",
      "keyup",
      "input",
      "change",
    ])
      target.addEventListener(event, (e) => {
        trace.push(id + ":" + event + (e.key ? ":" + e.key : ""));
        if (type === "bamboohr" && event === "keyup" && e.key === "Enter")
          show(id);
        else if (type === "bamboohr" && event === "keyup" && e.key === "Escape")
          doc.getElementById(id + "-menu")?.setAttribute("hidden", "");
        else if (type !== "bamboohr" && event === "click") show(id);
      });
  }
  const findAll = (xpath) => {
    const result = doc.evaluate(
      xpath,
      doc,
      null,
      w.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    return Array.from({ length: result.snapshotLength }, (_, index) =>
      result.snapshotItem(index),
    );
  };
  const find = (xpath) => findAll(xpath)[0] || null;
  const lowercase = (target) =>
    `translate(${target},'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')`;
  const waitCss = (selector) => {
    waits.push(["css", selector]);
    return w.JobsDOMWait.until(() => {
      const nodes = [...doc.querySelectorAll(selector)];
      return nodes.length ? nodes : null;
    });
  };
  const waitXPath = (xpath, timeout = 5000, attempts = 1) => {
    waits.push(["xpath", xpath, timeout, attempts]);
    return w.JobsDOMWait.until(() => {
      const nodes = findAll(xpath);
      return nodes.length ? nodes : null;
    }).then((nodes) => nodes || []);
  };
  Object.assign(w, {
    jobsFindXPath: find,
    jobsFindAllXPath: findAll,
    jobsLowercaseXPath: lowercase,
    jobsWaitForCssNodes: waitCss,
    jobsWaitForXPathNodesWithRetry: waitXPath,
  });
  return {
    w,
    doc,
    node,
    trace,
    waits,
    diagnostics,
    api: w.JobsMenuControls,
    popup,
    close: () => w.close(),
  };
}
