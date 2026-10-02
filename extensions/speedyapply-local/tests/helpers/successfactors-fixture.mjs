import { readWithDependencies } from "./runtime-source.mjs";
import { JSDOM } from "jsdom";

const custom = (name) =>
  readWithDependencies(
    new URL("../../src/custom/" + name + ".js", import.meta.url),
    "utf8",
  );
const sources = await Promise.all(
  [
    "dom-wait",
    "option-match",
    "profile-answers",
    "control-fields",
    "successfactors-controls",
    "form-pipeline",
  ].map(custom),
);

// Paged DOM model of the SuccessFactors linkage: numeric input ID,
// (ID + 1):page divs, repeated (ID + 1):_listSelect lists and 3-level scroller.
export function successfactorsFixture({
  pages = [["Alaska", "California"]],
  delay = 10,
  commitValue = true,
  initial = "",
  readonly = false,
  required,
  selected = "",
  question = "Country",
} = {}) {
  const dom = new JSDOM(
    '<!doctype html><form id="field"><label></label><div class="fieldComponentInput"><div id="90:selectContainer"><input id="90:_input"><button type="button" aria-label="Open list"></button></div></div></form>',
    {
      url: "https://career.example.successfactors.com/career",
      runScripts: "outside-only",
    },
  );
  const { window } = dom,
    doc = window.document,
    input = doc.getElementById("90:_input"),
    events = [];
  const timers = new Set();
  input.value = initial;
  input.readOnly = readonly;
  if (required !== undefined)
    input.setAttribute("aria-required", String(required));
  doc.querySelector("label").textContent = question;
  let scroller,
    inside,
    scrollCount = 0;
  function schedule(fn) {
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      fn();
    }, delay);
    timers.add(timer);
  }
  function addPage(index) {
    if (doc.getElementById(`91:${index}`) || !pages[index]) return;
    const page = doc.createElement("div");
    page.id = `91:${index}`;
    const list = doc.createElement("ul");
    list.id = "91:_listSelect";
    page.append(list);
    for (const item of pages[index]) {
      const title = typeof item === "string" ? item : item.label;
      const option = doc.createElement("li");
      option.setAttribute("role", "option");
      option.tabIndex = -1;
      if (item.disabled) option.setAttribute("aria-disabled", "true");
      const anchor = doc.createElement("a");
      anchor.title = title;
      anchor.textContent = title;
      option.append(anchor);
      if (selected === title) option.setAttribute("aria-selected", "true");
      option.addEventListener("click", () => {
        events.push("option:click:" + title);
        if (commitValue) {
          input.value = title;
          for (const node of doc.querySelectorAll('li[aria-selected="true"]'))
            node.setAttribute("aria-selected", "false");
          option.setAttribute("aria-selected", "true");
        }
      });
      option.addEventListener("change", (event) => {
        if (event.target === option) events.push("option:change");
      });
      option.blur = () => {
        events.push("option:blur");
      };
      list.append(option);
    }
    inside.append(page);
  }
  function open() {
    if (scroller) return;
    scroller = doc.createElement("div");
    scroller.id = "popup";
    inside = doc.createElement("div");
    scroller.append(inside);
    doc.body.append(scroller);
    scroller.scrollTo = () => {
      events.push("scroll:" + scrollCount);
      const index = scrollCount++;
      if (index && !doc.getElementById(`91:${index}`))
        schedule(() => addPage(index));
    };
    addPage(0);
  }
  input.addEventListener("click", () => {
    events.push("input:click");
    open();
  });
  for (const event of ["input", "change"])
    input.addEventListener(event, () => {
      events.push("input:" + event);
    });
  input.blur = () => {
    events.push("input:blur");
  };
  for (const source of sources) window.eval(source);
  return {
    dom,
    window,
    doc,
    input,
    events,
    open,
    addPage,
    controls: window.JobsSuccessFactorsControls,
    reader: window.JobsControlFields.create(
      doc,
      () => doc.getElementById("field"),
      { write: true },
    ),
    close() {
      for (const timer of timers) window.clearTimeout(timer);
      window.close();
    },
  };
}
