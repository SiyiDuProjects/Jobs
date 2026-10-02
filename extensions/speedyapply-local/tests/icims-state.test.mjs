import { chooseAnswer } from "./helpers/choose-answer.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const waitCode = await readWithDependencies(
  new URL("../src/custom/dom-wait.js", import.meta.url),
  "utf8",
);
const readerCode = await readWithDependencies(
  new URL("../src/custom/control-fields.js", import.meta.url),
  "utf8",
);
const componentCode = await readWithDependencies(
  new URL("../src/custom/icims-controls.js", import.meta.url),
  "utf8",
);
// An iCIMS search list: typing clears the results and the site answers a moment later.
function setup(labels = ["Alabama", "California"], commit = true) {
  const dom = new JSDOM(
    `<form><div>
    <select id="state" icimsdropdown-enabled="1" style="display:none"><option value="-1">Choose</option></select>
    <a role="combobox" id="state_icimsDropdown" aria-label="State/Province" aria-expanded="false"></a>
    <div class="dropdown-container"><input><ul></ul></div>
  </div></form>`,
    {
      url: "https://example.icims.com/jobs/1/candidate",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    doc = w.document,
    clicks = [],
    events = [];
  let searches = 0;
  w.eval(waitCode);
  const until = w.JobsDOMWait.until;
  w.JobsDOMWait.until = (read, options) =>
    until(read, { ...options, timeout: 80 });
  w.JobsDiagnostics = {
    note: (type, node, detail) => events.push({ type, detail, id: node?.id }),
  };
  const trigger = doc.getElementById("state_icimsDropdown"),
    search = doc.querySelector(".dropdown-container input");
  trigger.onclick = () =>
    trigger.setAttribute(
      "aria-expanded",
      String(trigger.getAttribute("aria-expanded") !== "true"),
    );
  search.addEventListener("input", () => {
    searches++;
    doc.querySelector("ul").replaceChildren();
    w.setTimeout(() => options(labels), 5);
  });
  function options(names) {
    doc.querySelector("ul").replaceChildren(
      ...names.map((name, index) => {
        const li = doc.createElement("li");
        li.id = "result-selectable_state_" + index;
        li.setAttribute("role", "option");
        li.setAttribute("dropdown-index", String(index));
        li.title = name;
        li.textContent = name;
        li.onclick = () => {
          clicks.push(name);
          if (commit) {
            const select = doc.querySelector("select");
            select.replaceChildren(new w.Option(name, name, true, true));
          }
        };
        return li;
      }),
    );
  }
  options(labels);
  w.eval(componentCode);
  w.eval(readerCode);
  const choose = () => chooseAnswer(trigger, "California");
  return {
    w,
    doc,
    trigger,
    clicks,
    events,
    options,
    choose,
    searches: () => searches,
    close: () => dom.window.close(),
  };
}

test("a loaded exact option is chosen at once, without a search or the first result", async () => {
  const h = setup();
  try {
    assert.equal(await h.choose(), h.trigger);
    assert.deepEqual(h.clicks, ["California"]);
    assert.equal(h.searches(), 0);
    assert(
      h.events.some(
        (event) =>
          event.type === "option_verified" && event.detail === "California",
      ),
    );
    const reader = h.w.JobsControlFields.create(h.doc),
      row = reader.scan().find((row) => row.node.id === "state_icimsDropdown");
    assert.equal(row.raw, "California");
    assert.equal(row.public.filled, true);
    assert.equal(row.public.supported, true);
    h.doc
      .querySelector("select")
      .replaceChildren(new h.w.Option("Choose", "-999", true, true));
    assert.equal(
      reader.scan().find((row) => row.node.id === "state_icimsDropdown").public
        .filled,
      false,
    );
  } finally {
    h.close();
  }
});

test("a delayed search result is observed without clicking a stale option", async () => {
  const h = setup(["Alabama"]);
  try {
    h.doc.querySelector(".dropdown-container input").addEventListener(
      "input",
      () => {
        h.w.setTimeout(() => h.options(["California"]), 30);
      },
      { once: true },
    );
    const pending = h.choose();
    await Promise.resolve();
    assert.deepEqual(h.clicks, []);
    assert.equal(await pending, h.trigger);
    assert.deepEqual(h.clicks, ["California"]);
    assert.equal(h.searches(), 1);
  } finally {
    h.close();
  }
});

test("missing, ambiguous or uncommitted selections fail instead of accepting the first result", async () => {
  for (const [labels, commit] of [
    [["Alabama"], true],
    [["California", "California"], true],
    [["California"], false],
  ]) {
    const h = setup(labels, commit);
    try {
      assert.equal(await h.choose(), null);
      assert(!h.clicks.includes("Alabama"));
      assert(h.events.some((event) => event.type === "option_failed"));
    } finally {
      h.close();
    }
  }
});
