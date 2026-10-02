import { JSDOM } from "jsdom";
import { installLegacyFixtureLibraries } from "./legacy-select-fixtures.mjs";

export function tagFixture(
  kind,
  {
    initial = [],
    delay = 0,
    accept = true,
    leaveQuery = false,
    host = "recruiting.ultipro.com",
  } = {},
) {
  const seek = kind === "seek";
  const html = seek
    ? '<section data-automation="skill-section"><h2>Skills</h2><ul></ul><button type="button" data-testid="add-skills">Add skills</button></section>'
    : '<div><div><h2>Skills</h2><span></span><span></span><span><button type="button" aria-label="Edit Skills">Edit</button></span></div></div><div id="skills-region" aria-expanded="false"><ul class="listtype"></ul></div>';
  const dom = new JSDOM("<!doctype html><form>" + html + "</form>", {
    url: seek
      ? "https://www.seek.com.au/job/123/apply"
      : `https://${host}/company/job`,
    runScripts: "outside-only",
  });
  const { window } = dom,
    doc = window.document,
    form = doc.querySelector("form"),
    events = [],
    timers = new Set();
  let editor, input, list;
  const displayList = doc.querySelector("ul");
  const append = (target, label) => {
    const li = doc.createElement("li");
    li.textContent = label;
    target.append(li);
  };
  initial.forEach((label) => append(displayList, label));
  function schedule(fn) {
    if (!delay) fn();
    else {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        fn();
      }, delay);
      timers.add(timer);
    }
  }
  function close(save) {
    events.push(save ? "save" : "close");
    if (seek) {
      if (save)
        displayList.replaceChildren(
          ...[...list.children].map((node) => node.cloneNode(true)),
        );
      editor.remove();
    } else {
      editor.setAttribute("aria-expanded", "false");
      input.remove();
      editor.querySelectorAll("button").forEach((button) => button.remove());
    }
  }
  function open() {
    if (
      editor?.isConnected &&
      (seek || editor.getAttribute("aria-expanded") === "true")
    )
      return;
    events.push("open");
    if (seek) {
      editor = doc.createElement("div");
      editor.setAttribute("data-automation", "skills-form-drawer");
      const added = doc.createElement("div");
      added.dataset.testid = "added-skills";
      list = doc.createElement("ul");
      added.append(list);
      editor.append(added);
      [...displayList.children].forEach((node) =>
        list.append(node.cloneNode(true)),
      );
      form.append(editor);
    } else {
      editor = doc.getElementById("skills-region");
      editor.setAttribute("aria-expanded", "true");
      list = editor.querySelector("ul");
    }
    input = doc.createElement("input");
    input.setAttribute(
      seek ? "data-automation" : "aria-label",
      seek ? "skills-tags-input" : "Skills",
    );
    editor.append(input);
    const add = doc.createElement("button");
    add.type = "button";
    add.setAttribute(
      "data-automation",
      seek ? "add-skill-button" : "item-add-button",
    );
    add.textContent = "Add";
    add.addEventListener("click", () => {
      const answer = input.value;
      events.push("add:" + answer);
      if (!accept) return;
      schedule(() => {
        append(list, answer);
        if (!leaveQuery) input.value = "";
      });
    });
    editor.append(add);
    const save = doc.createElement("button");
    save.type = "button";
    save.setAttribute(
      "data-automation",
      seek ? "skills-save-button" : "save-button",
    );
    save.textContent = "Save";
    save.addEventListener("click", () => close(true));
    editor.append(save);
    if (seek) {
      const cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.setAttribute("aria-label", "Close");
      cancel.addEventListener("click", () => close(false));
      editor.append(cancel);
    }
    for (const type of [
      "click",
      "focus",
      "blur",
      "focusout",
      "keydown",
      "keypress",
      "keyup",
      "input",
      "change",
    ])
      input.addEventListener(type, (event) =>
        events.push(
          `input:${type}${type.startsWith("key") ? ":" + event.key : ""}`,
        ),
      );
  }
  doc
    .querySelector(
      seek ? '[data-testid="add-skills"]' : '[aria-label="Edit Skills"]',
    )
    .addEventListener("click", open);
  installLegacyFixtureLibraries(window);
  return {
    window,
    doc,
    events,
    open,
    controls: window.JobsTagControls,
    get editor() {
      return editor;
    },
    get input() {
      return input;
    },
    get list() {
      return list;
    },
    reader: window.JobsControlFields.create(doc, () => form, { write: true }),
    close() {
      for (const timer of timers) window.clearTimeout(timer);
      window.close();
    },
  };
}
