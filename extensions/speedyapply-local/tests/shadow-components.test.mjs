import { chooseAnswer } from "./helpers/choose-answer.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import fs from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const modules = await Promise.all(
  ["dom-wait", "control-fields", "shadow-controls"].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
function setup(type, { required = false, commit = true } = {}) {
  const dom = new JSDOM("<form></form>", {
    url: "https://careers.smartrecruiters.com/fixture",
    runScripts: "outside-only",
  });
  const w = dom.window,
    doc = w.document,
    form = doc.querySelector("form"),
    events = [];
  const host = doc.createElement(
    type === "ui5-date"
      ? "ui5-date-picker-xweb-calendar-widget"
      : type === "date"
        ? "spl-date-field"
        : type === "auto"
          ? "spl-autocomplete"
          : type === "phone"
            ? "spl-phone-field"
            : type === "check"
              ? "spl-checkbox"
              : "spl-input",
  );
  host.id = "fixture";
  host.setAttribute("label", "Fixture question" + (required ? "*" : ""));
  form.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  let inner, input;
  if (["date", "ui5-date", "auto", "phone"].includes(type)) {
    shadow.innerHTML =
      type === "ui5-date"
        ? "<ui5-input-xweb-calendar-widget></ui5-input-xweb-calendar-widget>"
        : type === "phone"
          ? "<spl-input></spl-input>"
          : `<spl-internal-form-field><${type === "date" ? "spl-date-picker" : "spl-input"}></${type === "date" ? "spl-date-picker" : "spl-input"}></spl-internal-form-field>`;
    inner = shadow.querySelector(
      type === "ui5-date"
        ? "ui5-input-xweb-calendar-widget"
        : type === "date"
          ? "spl-date-picker"
          : "spl-input",
    );
    inner.attachShadow({ mode: "open" }).innerHTML = "<input>";
    input = inner.shadowRoot.querySelector("input");
  } else {
    shadow.innerHTML = `<input type="${type === "check" ? "checkbox" : "text"}">`;
    input = shadow.querySelector("input");
  }
  input.required = required;
  for (const event of ["input", "change", "focusout", "keydown", "keyup"])
    input.addEventListener(event, (e) =>
      events.push([
        event,
        e.bubbles,
        e.composed,
        e.key || "",
        e.keyCode || 0,
        e.inputType || "",
        e.data ?? null,
      ]),
    );
  host.addEventListener("change", (e) => {
    if (e.target === host) events.push(["host-change", e.composed]);
  });
  if (type === "auto") {
    const menu = doc.createElement("div");
    menu.setAttribute("slot", "menu");
    shadow.append(menu);
    for (const label of ["Example City", "Other City"]) {
      const option = doc.createElement("spl-select-option");
      option.setAttribute("label", label);
      option.innerHTML =
        "<spl-typography-body>" + label + "</spl-typography-body>";
      menu.append(option);
      option.onclick = () => {
        events.push(["option", label]);
        if (commit) {
          for (const other of menu.children) other.removeAttribute("selected");
          option.setAttribute("selected", "");
          input.value = "";
        }
      };
    }
  }
  for (const source of modules) w.eval(source);
  const reader = w.JobsControlFields.create(doc, () => form, { write: true });
  return {
    w,
    doc,
    form,
    host,
    shadow,
    inner,
    input,
    events,
    reader,
    api: w.JobsShadowControls,
    close: () => w.close(),
  };
}

for (const type of ["text", "date", "ui5-date", "check", "phone"])
  test(`shadow ${type}: canonical reader and supplement use the existing native value`, async () => {
    const h = setup(type, { required: true });
    try {
      assert.equal(h.reader.scan().length, 1);
      const answer =
        type === "check"
          ? true
          : type.includes("date")
            ? "2027-05-18"
            : type === "phone"
              ? "5307610000"
              : "Example";
      await h.reader.apply(h.reader.scan()[0], answer);
      assert.equal(h.reader.scan()[0].raw, answer);
      assert.equal(h.reader.state().ready, true);
      assert.equal(
        h.reader.response(h.reader.scan()[0]).response,
        type === "check" ? "Yes" : answer,
      );
    } finally {
      h.close();
    }
  });

test("SPL date preserves Enter keydown+keyup and UI5 preserves attributes and composed focusout", async () => {
  const spl = setup("date"),
    ui = setup("ui5-date");
  try {
    assert.equal(await chooseAnswer(spl.host, "2027-05-18"), spl.host);
    assert.deepEqual(
      spl.events.filter((e) =>
        ["input", "change", "keydown", "keyup"].includes(e[0]),
      ),
      [
        ["input", true, false, "", 0, "", null],
        ["change", true, false, "", 0, "", null],
        ["keydown", true, true, "Enter", 13, "", null],
        ["keyup", true, true, "Enter", 13, "", null],
      ],
    );
    assert.equal(await chooseAnswer(ui.host, "2027-05-18"), ui.host);
    assert.equal(ui.host.getAttribute("value"), "05/18/2027");
    assert.equal(ui.inner.getAttribute("value"), "05/18/2027");
    assert.deepEqual(ui.events, [
      ["input", true, true, "", 0, "insertText", "05/18/2027"],
      ["change", true, true, "", 0, "", null],
      ["host-change", true],
      ["focusout", true, true, "", 0, "", null],
      ["host-change", true],
    ]);
  } finally {
    spl.close();
    ui.close();
  }
});

test("shadow search text is not a selection; strict choice commits the exact candidate", async () => {
  const h = setup("auto", { required: true });
  try {
    h.input.value = "Example City";
    assert.equal(h.reader.scan()[0].public.filled, false);
    assert.equal(h.reader.state().ready, false);
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(await h.reader.readOptions(h.reader.scan()[0])),
      ),
      [
        { label: "Example City", value: "Example City" },
        { label: "Other City", value: "Other City" },
      ],
    );
    await h.reader.apply(h.reader.scan()[0], "Example City");
    assert.equal(h.reader.scan()[0].raw, "Example City");
    assert.equal(h.reader.state().ready, true);
    assert.equal(h.events.filter((e) => e[0] === "option").length, 1);
  } finally {
    h.close();
  }
});

test("closed shadow roots and hidden host ancestors do not masquerade as completed inputs", () => {
  const h = setup("text");
  try {
    h.host.hidden = true;
    assert.equal(h.reader.scan().length, 0);
    assert.equal(h.reader.visible(h.input), false);
    const closed = h.doc.createElement("spl-input");
    closed.setAttribute("label", "Closed field");
    closed.attachShadow({ mode: "closed" }).innerHTML =
      '<input value="not readable">';
    h.form.append(closed);
    assert.equal(h.reader.scan().length, 1);
    assert.equal(h.reader.scan()[0].public.supported, false);
    assert.equal(h.reader.state().ready, false);
  } finally {
    h.close();
  }
});

test("strict shadow write stops on replacement/cancellation and refuses partial dates", async () => {
  const h = setup("date");
  try {
    assert.equal(await chooseAnswer(h.host, "May 2027"), null);
    assert.equal(h.input.value, "");
    assert.equal(
      await chooseAnswer(h.host, "2027-05-18", { canProceed: () => false }),
      null,
    );
    assert.equal(h.input.value, "");
    const row = h.reader.scan()[0];
    h.host.remove();
    await assert.rejects(h.reader.apply(row, "2027-05-18"), /Field changed/);
  } finally {
    h.close();
  }
});

test("a readonly autocomplete commits only an actual option, without typing into it", async () => {
  const strict = setup("auto");
  try {
    strict.input.readOnly = true;
    assert.equal(await chooseAnswer(strict.host, "Example City"), strict.host);
    assert.equal(strict.api.value(strict.host), "Example City");
    assert(
      !strict.events.some(
        (event) => event[0] === "input" || event[0] === "change",
      ),
    );
  } finally {
    strict.close();
  }
});

test("shadow candidate reads and cache cannot cross a same-node question or URL change", async () => {
  for (const change of ["question", "url"]) {
    const h = setup("auto");
    try {
      await h.api.readOptions(h.host);
      assert.equal(h.api.cachedOptions(h.host).length, 2);
      if (change === "question") h.host.setAttribute("label", "New question");
      else h.w.history.replaceState({}, "", "/new-application");
      assert.equal(h.api.cachedOptions(h.host), undefined);
      const menu = h.shadow.querySelector('[slot="menu"]'),
        saved = [...menu.children];
      menu.replaceChildren();
      const pending = h.api.readOptions(h.host, () => true, {
        answer: "Example City",
      });
      if (change === "question")
        h.host.setAttribute("label", "Another question");
      else h.w.history.replaceState({}, "", "/third-application");
      const count = h.events.length;
      menu.append(...saved);
      assert.equal((await pending).length, 0);
      assert.equal(
        h.events.length,
        count,
        "No cleanup writes to replacement question",
      );
      assert.equal(h.api.cachedOptions(h.host), undefined);
    } finally {
      h.close();
    }
  }
});

test("shadow date text still requires a valid calendar date and internal passwords are excluded", () => {
  for (const type of ["date", "ui5-date"]) {
    const h = setup(type);
    try {
      h.input.value = "2027-02-30";
      assert.equal(h.reader.scan()[0].public.invalid, true);
      assert.equal(h.reader.state().ready, false);
    } finally {
      h.close();
    }
  }
  const h = setup("text");
  try {
    h.host.setAttribute("label", "Account");
    h.input.type = "password";
    h.input.value = "fixture-only";
    assert.equal(h.reader.scan().length, 0);
  } finally {
    h.close();
  }
});

test("SPL nested option content is one choice; a subtitle is not a second answer", async () => {
  const h = setup("auto");
  try {
    const options = [...h.shadow.querySelectorAll("spl-select-option")];
    options[0].removeAttribute("label");
    options[0].innerHTML =
      '<div class="c-spl-autocomplete-default-option"><div class="c-spl-autocomplete-option-content"><spl-typography-body><spl-truncate>Example City</spl-truncate></spl-typography-body><spl-typography-body class="c-spl-autocomplete-option-description">Region</spl-typography-body></div></div>';
    assert.deepEqual(
      Array.from(await h.api.readOptions(h.host), (x) => x.label),
      ["Example City", "Other City"],
    );
    assert.equal(await chooseAnswer(h.host, "Example City"), h.host);
    assert.equal(h.events.filter((e) => e[0] === "option").length, 1);
    assert.equal(h.api.value(h.host), "Example City");
  } finally {
    h.close();
  }
});

test("SPL still rejects genuinely distinct options with the same label", async () => {
  const h = setup("auto");
  try {
    const options = [...h.shadow.querySelectorAll("spl-select-option")];
    options[1].setAttribute("label", "Example City");
    options[1].textContent = "Example City";
    assert.equal(await chooseAnswer(h.host, "Example City"), null);
    assert.equal(h.events.filter((e) => e[0] === "option").length, 0);
  } finally {
    h.close();
  }
});

test("SPL catalog option is not ambiguous with its custom-text fallback", async () => {
  const h = setup("auto");
  try {
    const option = h.shadow.querySelector("spl-select-option");
    option.setAttribute("value", "catalog-1");
    const custom = option.cloneNode(true);
    custom.setAttribute("value", "#spl-custom-option");
    custom.onclick = () => assert.fail("the exact catalog option must win");
    option.before(custom);
    assert.equal(await chooseAnswer(h.host, "Example City"), h.host);
    assert.equal(option.hasAttribute("selected"), true);
    assert.equal(h.events.filter((e) => e[0] === "option").length, 1);
  } finally {
    h.close();
  }
});

test("SPL opens before searching so the menu-show reset cannot erase results", async () => {
  const h = setup("auto");
  try {
    const menu = h.shadow.querySelector('[slot="menu"]');
    const options = [...menu.children];
    menu.replaceChildren();
    h.shadow.append(h.doc.createElement("spl-dropdown"));
    h.input.setAttribute("aria-expanded", "false");
    h.input.addEventListener("click", () => {
      h.w.queueMicrotask(() => {
        menu.replaceChildren();
        h.input.setAttribute("aria-expanded", "true");
      });
    });
    h.input.addEventListener("input", () => {
      assert.equal(h.input.getAttribute("aria-expanded"), "true");
      menu.append(...options);
    });
    assert.equal(await chooseAnswer(h.host, "Example City"), h.host);
    assert.equal(h.events.filter((e) => e[0] === "input").length, 1);
  } finally {
    h.close();
  }
});

test("SPL custom values need a host commit and DOM readback, not just search text", async () => {
  for (const commit of [true, false]) {
    const h = setup("auto");
    try {
      h.host.setAttribute("allowcustomvalues", "");
      const option = h.shadow.querySelector("spl-select-option");
      option.setAttribute("value", "#spl-custom-option");
      option.onclick = () => {
        // The real custom option never receives a selected marker.
        if (commit) {
          h.host.dispatchEvent(
            new h.w.CustomEvent("spl-change", {
              bubbles: true,
              detail: { value: "Example City" },
            }),
          );
          const clear = h.doc.createElement("span");
          clear.className = "c-spl-autocomplete-close";
          h.shadow.append(clear);
        }
      };
      assert.equal(
        await chooseAnswer(h.host, "Example City"),
        commit ? h.host : null,
      );
      assert.equal(h.reader.scan()[0].public.filled, commit);
    } finally {
      h.close();
    }
  }
});

test("SPL month-year accepts month precision and verifies the rendered month after Enter", async () => {
  const h = setup("date", { required: true });
  try {
    h.host.setAttribute("type", "month-year");
    h.inner.setAttribute("type", "month-year");
    h.input.addEventListener("keyup", (e) => {
      if (e.key === "Enter") h.input.value = "05/2027";
    });
    assert.equal(await chooseAnswer(h.host, "2027-05"), h.host);
    assert.equal(h.api.value(h.host), "2027-05");
    assert.equal(h.reader.state().ready, true);
    h.input.value = "13/2027";
    assert.equal(h.reader.scan()[0].public.invalid, true);
    h.input.value = "";
    assert.equal(await chooseAnswer(h.host, "2027-02-30"), null);
  } finally {
    h.close();
  }
});

test("employment place rules expand region names but reject another city, state or country", () => {
  const h = setup("auto");
  try {
    const pick = h.w.JobsOptionMatch.pick;
    const spec = h.w.JobsProfileAnswers.locationSpec("Example City, CA");
    assert.equal(
      pick(["Example City, California, United States"], spec)?.label,
      "Example City, California, United States",
    );
    assert.equal(
      pick(
        [
          "Other City, California, United States",
          "Example City, Texas, United States",
        ],
        spec,
      ),
      null,
    );
    assert.equal(
      pick(
        [
          "Example City, California, United States",
          "Example City, CA, Another Country",
        ],
        spec,
      ),
      null,
    );
    const full = h.w.JobsProfileAnswers.locationSpec(
      "Example City, CA, United States",
    );
    assert.equal(pick(["Example City, CA, Another Country"], full), null);
  } finally {
    h.close();
  }
});
