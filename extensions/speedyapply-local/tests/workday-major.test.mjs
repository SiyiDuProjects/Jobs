import { readModule, functionBlock } from "./helpers/module-source.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
const source = await readModule(
  new URL("../source/content/adapters/workday.js", import.meta.url),
  "utf8",
);
const wait = await readWithDependencies(
  new URL("../src/custom/dom-wait.js", import.meta.url),
  "utf8",
);
const workday = await readWithDependencies(
  new URL("../src/custom/workday-controls.js", import.meta.url),
  "utf8",
);
const fields = await readWithDependencies(
  new URL("../src/custom/control-fields.js", import.meta.url),
  "utf8",
);
const profileAnswers = await Promise.all(
  ["option-match", "profile-answers"].map((n) =>
    readWithDependencies(
      new URL("../src/custom/" + n + ".js", import.meta.url),
      "utf8",
    ),
  ),
).then((parts) => parts.join("\n"));
const block = (name) => functionBlock(source, name);
// The major is one binding, as the education adapter declares it: the
// Profile's field of study chosen from the prompt's own search results.
const choose = (h, answer = "Physics") =>
  h.w.JobsFormPipeline.bind([
    {
      name: "major",
      find: () => h.w.document.querySelector("#major input"),
      answer: h.w.JobsProfileAnswers.knownSpec("Field of study", answer),
    },
  ]).then((results) => results[0]);
function setup() {
  const dom = new JSDOM(
      '<div id="major" data-automation-id="multiSelectContainer"><input aria-label="Field of Study" data-uxi-widget-type="selectinput" data-uxi-multiselect-id="major"><ul data-automation-id="selectedItemList"></ul></div><div data-uxi-popup-anchor="major"></div><div data-uxi-popup-anchor="other"></div>',
      {
        url: "https://fixture.myworkdayjobs.com/apply",
        runScripts: "outside-only",
      },
    ),
    w = dom.window;
  const root = w.document.querySelector('[data-uxi-popup-anchor="major"]');
  w.jobsFindAllXPath = (path) => {
    const out = w.document.evaluate(
      path,
      w.document,
      null,
      w.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    return Array.from({ length: out.snapshotLength }, (_, i) =>
      out.snapshotItem(i),
    );
  };
  w.jobsFindXPath = (path) => w.jobsFindAllXPath(path)[0] || null;
  w.jobsClick = (selector, xpath) => {
    const node = xpath
      ? w.jobsFindXPath(selector)
      : w.document.querySelector(selector);
    node?.click();
    return node;
  };
  w.jobsLowercaseXPath = (path) =>
    `translate(${path}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
  w.eval(profileAnswers);
  w.eval(fields);
  w.eval(workday);
  w.eval(wait);
  const until = w.JobsDOMWait.until;
  // Keep the real MutationObserver scheduler; shorten only the missing-case deadline.
  const waits = [];
  w.JobsDOMWait.until = (read, options) => {
    waits.push(options?.timeout);
    return until(read, { ...options, timeout: 80 });
  };
  const clicks = [];
  function option(text, parent = root, commit = true) {
    const node = w.document.createElement("div");
    node.setAttribute("role", "option");
    node.innerHTML =
      '<div><input type="checkbox"></div><div data-automation-id="promptOption"></div>';
    node.lastElementChild.textContent = text;
    parent.append(node);
    node.querySelector("input").addEventListener("click", () => {
      clicks.push(text);
      if (commit) {
        const pill = w.document.createElement("li");
        pill.dataset.automationId = "selectedItem";
        const label = w.document.createElement("span");
        label.dataset.automationId = "promptOption";
        label.textContent = text;
        pill.append(label);
        w.document
          .querySelector('[data-automation-id="selectedItemList"]')
          .replaceChildren(pill);
      }
    });
    return node;
  }
  return { w, root, clicks, option, waits, close: () => w.close() };
}
test("major chooses exact Physics even when Applied Physics appears first", async () => {
  const h = setup();
  try {
    h.option("Applied Physics");
    h.option("  PHYSICS  ");
    const result = await choose(h);
    assert(result === h.w.document.querySelector("#major input"));
    assert.deepEqual(h.clicks, ["  PHYSICS  "]);
  } finally {
    h.close();
  }
});
test("major commits the general catalog label without choosing a specialist discipline", async () => {
  const h = setup();
  try {
    h.option("Physics Teacher Education");
    h.option("Physics, Other");
    h.option("Applied Physics");
    h.option("Physics, General");
    assert.equal(await choose(h), h.w.document.querySelector("#major input"));
    assert.deepEqual(h.clicks, ["Physics, General"]);
    assert.equal(
      h.w.JobsWorkdayControls.value(
        h.w.document.querySelector("#major input"),
      )[0],
      "Physics, General",
    );
  } finally {
    h.close();
  }
});

test("major waits for the asynchronous exact result instead of clicking the first similar result", async () => {
  const h = setup();
  try {
    h.option("Applied Physics");
    h.option(
      "Physics",
      h.w.document.querySelector('[data-uxi-popup-anchor="other"]'),
    );
    const result = choose(h);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(h.clicks, []);
    h.option("Physics");
    assert((await result) === h.w.document.querySelector("#major input"));
    assert.deepEqual(h.clicks, ["Physics"]);
  } finally {
    h.close();
  }
});
test("missing or disabled exact major does not select a different major", async () => {
  const h = setup();
  try {
    h.option("Applied Physics");
    h.option("Engineering");
    h.option("Physics").querySelector("input").disabled = true;
    assert.equal(await choose(h), null);
    assert.deepEqual(h.clicks, []);
  } finally {
    h.close();
  }
});

test("search starts immediately even when the popup only mounts after input", async () => {
  const h = setup();
  try {
    h.root.remove();
    const search = h.w.document.querySelector("#major input");
    search.addEventListener(
      "input",
      () => {
        assert.equal(search.value, "Physics");
        h.w.document.body.append(h.root);
        h.option("Applied Physics");
        h.option("Physics");
      },
      { once: true },
    );
    const result = await choose(h);
    assert(result === h.w.document.querySelector("#major input"));
    assert.deepEqual(h.clicks, ["Physics"]);
    assert.deepEqual(h.waits, [2500, 2500, 1500]);
  } finally {
    h.close();
  }
});

test("search presses Enter before selecting even when an exact option is already present, without blur", async () => {
  const h = setup();
  try {
    const search = h.w.document.querySelector("#major input");
    const wrong = h.option("Applied Physics").querySelector("input");
    h.option("Physics");
    let searches = 0;
    search.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        searches++;
        assert.deepEqual(h.clicks, []);
        assert.equal(search.value, "Physics");
      }
    });
    search.addEventListener("blur", () => wrong.click());
    const result = await choose(h);
    assert(result === h.w.document.querySelector("#major input"));
    assert.deepEqual(h.clicks, ["Physics"]);
    assert.equal(searches, 1);
    assert.deepEqual(h.waits, [2500, 2500, 1500]);
  } finally {
    h.close();
  }
});

test("Enter performs search and the last exact Physics option is selected without scrolling", async () => {
  const h = setup();
  try {
    h.option("Applied Physics");
    let searches = 0,
      scrolls = 0;
    h.root.addEventListener("scroll", () => scrolls++);
    h.w.document
      .querySelector("#major input")
      .addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        searches++;
        h.w.setTimeout(() => {
          h.root.replaceChildren();
          for (const name of [
            "Applied Physics",
            "Atomic Physics",
            "Biomedical Physics",
            "Chemical Physics",
            "Engineering Physics",
            "Physics",
          ])
            h.option(name);
        }, 10);
      });
    const result = await choose(h);
    assert(result === h.w.document.querySelector("#major input"));
    assert.deepEqual(h.clicks, ["Physics"]);
    assert.equal(searches, 1);
    assert.equal(scrolls, 0);
    assert.equal(
      h.w.document.querySelector('[data-automation-id="selectedItem"]')
        .textContent,
      "Physics",
    );
  } finally {
    h.close();
  }
});

test("exact option below the visible list viewport is selected directly from DOM", async () => {
  const h = setup();
  try {
    h.root.style.cssText = "max-height:40px;overflow-y:auto";
    h.option("Applied Physics");
    const physics = h.option("Physics");
    physics.style.marginTop = "500px";
    let scrolled = 0;
    h.root.addEventListener("scroll", () => scrolled++);
    assert((await choose(h)) === h.w.document.querySelector("#major input"));
    assert.equal(h.root.scrollTop, 0);
    assert.equal(scrolled, 0);
    assert.deepEqual(h.clicks, ["Physics"]);
  } finally {
    h.close();
  }
});

test("a checked option without a committed pill is not reported as successful", async () => {
  const h = setup();
  try {
    h.option("Physics", h.root, false);
    assert.equal(await choose(h), null);
    // Empty is unanswered, not a wrong choice; the run puts the Profile answer on the card.
    const row = h.w.JobsControlFields.create(h.w.document, () =>
      h.w.document.querySelector("#major"),
    ).scan()[0];
    assert.equal(row.public.invalid, false);
    assert.equal(row.public.filled, false);
  } finally {
    h.close();
  }
});

test("missing exact result closes the popup and a wrongly committed default fails validation", async () => {
  const h = setup();
  try {
    const wrong = h.option("Applied Physics").querySelector("input"),
      search = h.w.document.querySelector("#major input");
    let closed = 0;
    search.addEventListener("keydown", (event) => {
      if (event.key === "Enter") wrong.click();
      if (event.key === "Escape") {
        closed++;
        h.root.hidden = true;
      }
    });
    assert.equal(await choose(h), null);
    assert.equal(closed, 1);
    const reader = h.w.JobsControlFields.create(h.w.document, () =>
      h.w.document.querySelector("#major"),
    );
    assert.equal(reader.state().ready, false);
    assert.equal(reader.scan()[0].public.invalid, true);
    h.w.document.querySelector(
      '[data-automation-id="selectedItem"] span',
    ).textContent = "Physics";
    assert.equal(reader.state().ready, true);
  } finally {
    h.close();
  }
});
test("generic bachelor level does not become BS, while explicit Arts can select BA", async () => {
  for (const label of [
    "BA",
    "Bachelor of Arts (B.A)",
    "Bachelor of Arts (B.A.)",
  ])
    for (const degree of ["Bachelor's", "Bachelor of Arts"]) {
      const h = setup();
      try {
        const section = h.w.document.createElement("div");
        section.setAttribute("aria-labelledby", "Education-section");
        section.innerHTML =
          '<div data-automation-id="education-1"><div data-automation-id="formField-degree"><button data-automation-id="degree" aria-haspopup="listbox">Select One</button></div></div>';
        h.w.document.body.append(section);
        const button = section.querySelector("button");
        button.onclick = () => {
          const list = h.w.document.createElement("div");
          list.id = "degree-options";
          list.setAttribute("role", "listbox");
          button.setAttribute("aria-controls", list.id);
          h.w.document.body.append(list);
          for (const text of ["Bachelor of Science (B.S)", label]) {
            const option = h.w.document.createElement("div");
            option.setAttribute("role", "option");
            option.textContent = text;
            option.onclick = () => {
              button.textContent = text;
              list.remove();
            };
            list.append(option);
          }
        };
        button.onkeydown = (event) => {
          if (event.key === "Escape")
            h.w.document.getElementById("degree-options")?.remove();
        };
        h.w.eval(block("workdayFillEducationHistory"));
        await h.w.workdayFillEducationHistory([
          { school: "Berkeley", degree, fieldOfStudy: "Physics" },
        ]);
        assert.equal(
          button.textContent,
          degree === "Bachelor of Arts" ? label : "Select One",
        );
      } finally {
        h.close();
      }
    }
});

test("the actual education adapter validates an existing major without changing the selection", async () => {
  for (const label of ["Accounting", "Physics"]) {
    const h = setup();
    try {
      const major = h.w.document.querySelector("#major");
      const section = h.w.document.createElement("div");
      section.setAttribute("aria-labelledby", "Education-section");
      section.innerHTML =
        '<div data-automation-id="education-1"><div data-automation-id="formField-fieldOfStudy"></div></div>';
      h.w.document.body.append(section);
      section
        .querySelector('[data-automation-id="formField-fieldOfStudy"]')
        .append(major);
      major.querySelector("ul").innerHTML =
        '<li data-automation-id="menuItem"><div data-automation-id="selectedItem"><p data-automation-id="promptOption">' +
        label +
        "</p></div></li>";
      h.w.eval(block("workdayFillEducationHistory"));
      await h.w.workdayFillEducationHistory([
        { school: "Berkeley", degree: "Bachelor's", fieldOfStudy: "Physics" },
      ]);
      const reader = h.w.JobsControlFields.create(h.w.document, () => section);
      assert.equal(
        major.querySelector('[data-automation-id="promptOption"]').textContent,
        label,
      );
      assert.equal(
        reader.state().ready,
        label === "Physics",
        label + " must be checked against Physics",
      );
      assert.equal(
        h.w.JobsWorkdayControls.selectionValid(major.querySelector("input")),
        label === "Physics",
      );
      assert.deepEqual(h.clicks, []);
    } finally {
      h.close();
    }
  }
});

test("the actual education adapter searches Physics before selecting from an initial Accounting list", async () => {
  for (const searchSucceeds of [true, false]) {
    const h = setup();
    try {
      const major = h.w.document.querySelector("#major"),
        search = major.querySelector("input");
      const section = h.w.document.createElement("div");
      section.setAttribute("aria-labelledby", "Education-section");
      section.innerHTML =
        '<div data-automation-id="education-1"><div data-automation-id="formField-fieldOfStudy"></div></div>';
      h.w.document.body.append(section);
      section
        .querySelector('[data-automation-id="formField-fieldOfStudy"]')
        .append(major);
      h.option("Accounting");
      h.option("Advanced Computing");
      h.option("Advertising");
      let searches = 0;
      search.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        searches++;
        assert.equal(search.value, "Physics");
        if (searchSucceeds)
          h.w.setTimeout(() => {
            h.root.replaceChildren();
            h.option("Applied Physics");
            h.option("Physics");
          }, 10);
      });
      h.w.eval(block("workdayFillEducationHistory"));
      await h.w.workdayFillEducationHistory([
        { school: "Berkeley", degree: "Bachelor's", fieldOfStudy: "Physics" },
      ]);
      assert.equal(searches, 1);
      assert.deepEqual(h.clicks, searchSucceeds ? ["Physics"] : []);
      // A failed optional major stays blank without blocking; the run shows it on the card (workday-defaults).
      assert.equal(
        h.w.JobsControlFields.create(h.w.document, () => section)
          .scan()
          .some((row) => row.public.invalid),
        false,
      );
    } finally {
      h.close();
    }
  }
});

test("Visa waits for the asynchronously opened prompt and its search mode before choosing Physics", async () => {
  const h = setup();
  try {
    const search = h.w.document.querySelector("#major input");
    h.root.remove();
    // Live Visa: the responsive prompt mounts after the click, initially as
    // issearch=false. Enter sent before mounting does not perform the search.
    h.root.setAttribute("data-uxi-widget-type", "multiselectlist");
    h.root.setAttribute("data-uxi-multiselectlist-issearch", "false");
    let searches = 0;
    search.addEventListener(
      "click",
      () =>
        h.w.setTimeout(() => {
          h.w.document.body.append(h.root);
          h.option("Accounting");
          h.option("Physics");
        }, 20),
      { once: true },
    );
    search.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !h.root.isConnected) return;
      searches++;
      assert.equal(search.value, "Physics");
      h.w.setTimeout(() => {
        h.root.replaceChildren();
        h.root.setAttribute("data-uxi-multiselectlist-issearch", "true");
        h.option("Physical Therapy");
        h.option("Physics");
        h.option("Radio Physics, Electronics");
      }, 20);
    });
    const result = await choose(h);
    assert(result === h.w.document.querySelector("#major input"));
    assert.equal(searches, 1);
    assert.deepEqual(h.clicks, ["Physics"]);
    assert.equal(
      h.root.getAttribute("data-uxi-multiselectlist-issearch"),
      "true",
    );
  } finally {
    h.close();
  }
});
