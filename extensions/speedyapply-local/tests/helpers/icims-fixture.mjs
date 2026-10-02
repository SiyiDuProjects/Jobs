import { readWithDependencies } from "./runtime-source.mjs";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";

const modules = await Promise.all(
  ["dom-wait", "control-fields", "icims-controls"].map((name) =>
    readWithDependencies(
      new URL("../../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
export function icimsFixture({
  labels = ["Alabama", "California"],
  searchedLabels = labels,
  commit = true,
  delay = 18,
  writerDelay = 0,
  waitTimeout = 110,
  required = false,
  selected = "",
} = {}) {
  const dom = new JSDOM(
    `<form><div id="state-field"><label for="state">State/Province${required ? "*" : ""}</label>
    <select id="state" icimsdropdown-enabled="1" style="display:none" ${required ? "required" : ""}><option value="-1">Choose</option></select>
    <a role="combobox" id="state_icimsDropdown" aria-expanded="false"></a>
    <div id="state-menu" class="dropdown-container"><input><ul></ul></div>
  </div><div id="other-field"><label for="other">Other question</label>
    <select id="other" icimsdropdown-enabled="1" style="display:none"><option value="">Choose</option></select>
    <a role="combobox" id="other_icimsDropdown" aria-expanded="false"></a>
    <div class="dropdown-container"><input><ul><li role="option" dropdown-index="0" title="California">California</li></ul></div>
  </div></form>`,
    {
      url: "https://fixture.icims.com/jobs/1/candidate",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    doc = w.document,
    trigger = doc.getElementById("state_icimsDropdown"),
    input = doc.querySelector("#state-menu input"),
    select = doc.getElementById("state"),
    list = doc.querySelector("#state-menu ul"),
    trace = [],
    diagnostics = [];
  for (const code of modules) w.eval(code);
  const until = w.JobsDOMWait.until;
  let writesInFlight = 0,
    responsePending = false;
  const writeText = w.JobsControlFields.writeText;
  w.JobsControlFields.writeText = async (...args) => {
    writesInFlight++;
    try {
      const result = await writeText(...args);
      if (writerDelay)
        await new Promise((resolve) => w.setTimeout(resolve, writerDelay));
      return result;
    } finally {
      writesInFlight--;
    }
  };
  // Model the normal widget protocol explicitly: typing clears the list; only
  // after the writer settles and a result/reset wait observes that empty phase
  // does the asynchronous response begin. Wall-clock scheduling under the full
  // suite must not turn this fixture into the historical missed-reset race.
  w.JobsDOMWait.until = (read, waitOptions = {}) =>
    until(
      () => {
        const result = read();
        if (
          responsePending &&
          !writesInFlight &&
          list.childElementCount === 0
        ) {
          responsePending = false;
          w.setTimeout(() => options(searchedLabels), delay);
        }
        return result;
      },
      { ...waitOptions, timeout: waitTimeout },
    );
  w.JobsDiagnostics = {
    note: (type, node, detail) =>
      diagnostics.push({ type, id: node?.id, detail }),
  };
  function options(names) {
    list.replaceChildren(
      ...names.map((name, index) => {
        const option = doc.createElement("li");
        option.id = "result-state-" + index;
        option.setAttribute("role", "option");
        option.setAttribute("dropdown-index", index);
        option.title = name;
        option.textContent = name;
        for (const type of ["mouseover", "mousedown", "mouseup", "click"])
          option.addEventListener(type, () => {
            trace.push("option:" + type + ":" + name);
            if (type === "click" && commit) {
              select.replaceChildren(new w.Option(name, name, true, true));
              select.dispatchEvent(new w.Event("change", { bubbles: true }));
            }
          });
        return option;
      }),
    );
  }
  options(labels);
  if (selected)
    select.replaceChildren(new w.Option(selected, selected, true, true));
  trigger.onclick = () => {
    trace.push("trigger:click");
    trigger.setAttribute(
      "aria-expanded",
      trigger.getAttribute("aria-expanded") === "true" ? "false" : "true",
    );
  };
  doc.querySelector("#other-field li").onclick = () =>
    trace.push("WRONG QUESTION");
  for (const type of [
    "click",
    "focus",
    "input",
    "change",
    "keydown",
    "keyup",
    "blur",
    "focusout",
  ])
    input.addEventListener(type, () =>
      trace.push("input:" + type + ":" + input.value),
    );
  input.addEventListener("keyup", () => {
    options([]);
    responsePending = searchedLabels !== null;
  });
  const find = (path) =>
    doc.evaluate(path, doc, null, w.XPathResult.FIRST_ORDERED_NODE_TYPE, null)
      .singleNodeValue;
  Object.assign(w, { jobsFindXPath: find });
  return {
    w,
    doc,
    trigger,
    input,
    select,
    list,
    trace,
    diagnostics,
    options,
    api: w.JobsIcimsControls,
    close: () => w.close(),
  };
}
