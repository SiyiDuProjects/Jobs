import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import { functionBlock } from "./helpers/menu-fixtures.mjs";

const read = (path) =>
  readWithDependencies(new URL("../" + path, import.meta.url), "utf8");
const scripts = await Promise.all(
  [
    "src/custom/dom-wait.js",
    "src/custom/control-fields.js",
    "src/custom/workday-controls.js",
  ].map(read),
);
const adapter = await readModule(
  new URL("../source/content/adapters/workday.js", import.meta.url),
  "utf8",
);
function page(html) {
  const w = new JSDOM(
      '<form data-automation-id="applyFlowPage">' + html + "</form>",
      {
        url: "https://fixture.myworkdayjobs.com/apply",
        runScripts: "outside-only",
      },
    ).window,
    doc = w.document;
  scripts.forEach((script) => w.eval(script));
  const all = (query) => {
    const result = doc.evaluate(
      query,
      doc,
      null,
      w.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    return Array.from({ length: result.snapshotLength }, (_, i) =>
      result.snapshotItem(i),
    );
  };
  Object.assign(w, {
    jobsFindXPath: (query) => all(query)[0] || null,
    jobsWaitForXPathNodes: async (query) => all(query),
    jobsLowercaseXPath: (value) =>
      `translate(${value}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`,
  });
  return { w, doc };
}
// A Workday listbox: a button whose options mount when it is opened.
function listbox(doc, button, labels, onChoose = () => {}) {
  button.onclick = () => {
    const id = button.id + "-list";
    doc.getElementById(id)?.remove();
    button.setAttribute("aria-controls", id);
    doc.body.insertAdjacentHTML(
      "beforeend",
      `<ul id="${id}" role="listbox">` +
        labels.map((label) => `<li role="option">${label}</li>`).join("") +
        "</ul>",
    );
    for (const option of doc.getElementById(id).children)
      option.onclick = () => {
        button.textContent = option.textContent;
        doc.getElementById(id).remove();
        onChoose(option.textContent);
      };
  };
}

test("Workday source search prompt: categories until searched; the preferred source is found by searching its name", async () => {
  for (const profile of [
    {},
    {
      applicationData: {
        aiNotes:
          "Recruiting-source preference: prefer LinkedIn, then Job Board/Online.",
      },
    },
  ]) {
    const { w, doc } = page(
      '<div data-automation-id="formField-source"><label for="source">How Did You Hear About Us?*</label><div data-automation-id="multiSelectContainer"><input id="source" data-uxi-widget-type="selectinput" data-uxi-multiselect-id="src" aria-required="true"><ul data-automation-id="selectedItemList"></ul></div></div>',
    );
    const input = doc.getElementById("source"),
      searches = [];
    const popup = () => {
      let box = doc.querySelector("[data-uxi-popup-anchor]");
      if (!box) {
        box = doc.createElement("div");
        box.setAttribute("data-uxi-popup-anchor", "src");
        box.setAttribute("data-uxi-multiselectlist-issearch", "false");
        doc.body.append(box);
      }
      return box;
    };
    const show = (labels, search) => {
      const box = popup();
      box.setAttribute("data-uxi-multiselectlist-issearch", String(search));
      box.replaceChildren();
      for (const label of labels) {
        const option = doc.createElement("div");
        option.setAttribute("role", "option");
        option.innerHTML =
          '<input type="checkbox"><span data-automation-id="promptOption"></span>';
        option.lastElementChild.textContent = label;
        option.firstElementChild.onclick = () => {
          doc.querySelector("ul").innerHTML =
            '<li data-automation-id="selectedItem"><span data-automation-id="promptOption">' +
            label +
            "</span></li>";
          input.value = "";
          popup().remove();
        };
        box.append(option);
      }
    };
    // Opening lists only the categories; a search reaches the sources inside them.
    input.onclick = () => show(["Job Board", "Social Media"], false);
    input.onkeydown = (event) => {
      if (event.key === "Escape") {
        popup().remove();
        return;
      }
      if (event.key !== "Enter") return;
      searches.push(input.value);
      show(input.value === "LinkedIn" ? ["LinkedIn"] : [], true);
    };
    w.eval(functionBlock(adapter, "workdayFillPriorEmploymentAndSource"));
    try {
      await w.workdayFillPriorEmploymentAndSource(profile);
      assert.equal(
        doc.querySelector('[data-automation-id="selectedItem"]')?.textContent,
        "LinkedIn",
      );
      assert.deepEqual(
        searches,
        ["LinkedIn"],
        "the first preferred source is searched once and committed",
      );
    } finally {
      w.close();
    }
  }
});

test("Workday phone device type defaults to Mobile (or Cell) when the Profile has none", async () => {
  for (const labels of [
    ["Home", "Mobile", "Work"],
    ["Home", "Cell"],
  ]) {
    const { w, doc } = page(
      '<div data-automation-id="formField-phoneType"><label for="type">Phone Device Type*</label><button type="button" id="type" data-automation-id="phone-device-type" aria-haspopup="listbox">Select One</button></div>',
    );
    listbox(doc, doc.getElementById("type"), labels);
    w.eval(functionBlock(adapter, "workdayFillContact"));
    try {
      await w.workdayFillContact({});
      assert.equal(
        doc.getElementById("type").textContent,
        labels.includes("Mobile") ? "Mobile" : "Cell",
      );
    } finally {
      w.close();
    }
  }
});

test("Workday language proficiency controls that appear after the language is chosen are all filled", async () => {
  const { w, doc } = page(
    '<div aria-labelledby="Languages-section"><div data-automation-id="language-1"><div data-automation-id="formField-language"><label for="language">Language*</label><button type="button" id="language" name="language" data-automation-id="language" aria-haspopup="listbox">Select One</button></div></div></div>',
  );
  const levels = ["Beginner", "Intermediate", "Advanced", "Fluent"];
  listbox(doc, doc.getElementById("language"), ["Chinese", "English"], () => {
    // Listening, Reading, Speaking and Writing mount only after a language is selected.
    const entry = doc.querySelector('[data-automation-id="language-1"]');
    ["Listening", "Reading", "Speaking", "Writing"].forEach((skill, index) => {
      entry.insertAdjacentHTML(
        "beforeend",
        `<div data-automation-id="formField-languageProficiency"><label for="level${index}">${skill}*</label><button type="button" id="level${index}" data-automation-id="languageProficiency-${index}" aria-haspopup="listbox">Select One</button></div>`,
      );
      listbox(doc, doc.getElementById("level" + index), levels);
    });
  });
  w.eval(functionBlock(adapter, "workdayFillLanguages"));
  try {
    await w.workdayFillLanguages([
      { language: "English", fluent: false, proficiency: "Fluent" },
    ]);
    assert.equal(doc.getElementById("language").textContent, "English");
    assert.deepEqual(
      [0, 1, 2, 3].map(
        (index) => doc.getElementById("level" + index).textContent,
      ),
      ["Fluent", "Fluent", "Fluent", "Fluent"],
    );
  } finally {
    w.close();
  }
});

test("a Workday list value the page drops right after its commit is not counted as kept", async () => {
  for (const drop of [false, true]) {
    const { w, doc } = page(
      '<div data-automation-id="formField-age"><label for="age">Are you at least 18 years of age?*</label><button type="button" id="age" aria-haspopup="listbox">Select One</button></div>',
    );
    const button = doc.getElementById("age");
    w.JobsWorkdayControls.listbox(button);
    // Excellus: a neighbouring write re-rendered the list and cleared it ~0.2 s after the commit.
    listbox(doc, button, ["Yes", "No"], () => {
      if (drop)
        w.setTimeout(() => {
          button.textContent = "Select One";
        }, 60);
    });
    try {
      const root = doc.querySelector("form");
      assert(
        await w.JobsControlFields.chooseSpec(
          button,
          w.JobsProfileAnswers.literalSpec("known-answer", "Yes"),
        ),
      );
      assert.equal(await w.JobsFormPipeline.held(root, button), !drop);
    } finally {
      w.close();
    }
  }
});

test("a committed choice that already equals the Profile is kept; text is always rewritten (visible text is not proof of commit)", async () => {
  for (const prefill of ["Ada", "Bea"]) {
    const { w, doc } = page(
      '<div data-automation-id="formField-legalName--firstName"><label for="first">First Name*</label><input id="first" data-automation-id="legalNameSection_firstName" required></div><div data-automation-id="formField-degree"><label for="degree">Degree*</label><button type="button" id="degree" aria-haspopup="listbox">BA</button></div>',
    );
    const input = doc.getElementById("first"),
      degree = doc.getElementById("degree"),
      writes = [];
    input.value = prefill;
    input.addEventListener("input", () => writes.push("first"));
    w.JobsWorkdayControls.listbox(degree);
    listbox(doc, degree, ["BA", "BS"], () => writes.push("degree"));
    try {
      await w.JobsFormPipeline.bind([
        { name: "first", find: () => input, answer: "Ada", replace: true },
        {
          name: "degree",
          find: () => degree,
          answer: w.JobsProfileAnswers.degreeSpec("Bachelor of Arts"),
          replace: true,
        },
      ]);
      assert.equal(input.value, "Ada");
      assert.equal(degree.textContent, "BA");
      assert.deepEqual(
        writes,
        ["first"],
        "the degree already shows BA and is not reopened; the text is rewritten",
      );
    } finally {
      w.close();
    }
  }
});

test("a Workday list that replaces its element on commit is still counted as kept", async () => {
  const { w, doc } = page(
    '<div data-automation-id="formField-auth"><label for="auth">Are you legally authorized to work in the United States?*</label><button type="button" id="auth" aria-haspopup="listbox">Select One</button></div>',
  );
  const button = doc.getElementById("auth");
  w.JobsWorkdayControls.listbox(button);
  listbox(doc, button, ["Yes", "No"], (label) => {
    // Wellington: the committed list re-renders as a new element 50 ms later.
    w.setTimeout(() => {
      const fresh = button.cloneNode(false);
      fresh.textContent = label;
      button.replaceWith(fresh);
      w.JobsWorkdayControls.listbox(fresh);
    }, 50);
  });
  try {
    assert(
      await w.JobsControlFields.chooseSpec(
        button,
        w.JobsProfileAnswers.literalSpec("known-answer", "Yes"),
      ),
    );
    assert.equal(
      await w.JobsFormPipeline.held(doc.querySelector("form"), button),
      true,
    );
    assert.equal(doc.getElementById("auth").textContent, "Yes");
  } finally {
    w.close();
  }
});

test("a Workday text box replaced by a new element right after the write counts as written", async () => {
  const { w, doc } = page(
    '<div data-automation-id="formField-legalName--firstName"><label for="first">First Name*</label><input id="first" data-automation-id="legalNameSection_firstName" required></div>',
  );
  const field = doc.querySelector(
    '[data-automation-id="formField-legalName--firstName"]',
  );
  // RTX: the controlled input re-mounts with the committed value.
  const swap = () => {
    const old = doc.getElementById("first");
    const fresh = old.cloneNode(false);
    fresh.value = old.value;
    old.replaceWith(fresh);
  };
  doc.getElementById("first").addEventListener("input", swap, { once: true });
  const book = w.JobsFormPipeline.ledger(doc.querySelector("form"));
  try {
    const result = await w.JobsFormPipeline.write(
      doc.getElementById("first"),
      { value: "Ada" },
      {
        ledger: book,
        root: doc.querySelector("form"),
        decider: "binding:first-name",
      },
    );
    assert(result.ok, result.reason);
    assert.equal(doc.getElementById("first").value, "Ada");
  } finally {
    w.close();
  }
});

test("an optional Workday major whose search finds nothing stays blank and does not block the step", async () => {
  const { w, doc } = page(
    '<div data-automation-id="formField-fieldOfStudy"><label for="major">Field of Study</label><div data-automation-id="multiSelectContainer"><input id="major" data-uxi-widget-type="selectinput" data-uxi-multiselect-id="study"><ul data-automation-id="selectedItemList"></ul></div></div>',
  );
  const input = doc.getElementById("major");
  const popup = () => {
    let box = doc.querySelector("[data-uxi-popup-anchor]");
    if (!box) {
      box = doc.createElement("div");
      box.setAttribute("data-uxi-popup-anchor", "study");
      box.setAttribute("data-uxi-multiselectlist-issearch", "false");
      doc.body.append(box);
    }
    return box;
  };
  input.onclick = () => popup();
  input.onkeydown = (event) => {
    if (event.key === "Escape") {
      popup().remove();
      return;
    }
    if (event.key === "Enter") {
      const box = popup();
      box.setAttribute("data-uxi-multiselectlist-issearch", "true");
      box.replaceChildren();
    }
  };
  try {
    const reader = w.JobsControlFields.create(doc, () =>
      doc.querySelector("form"),
    );
    assert.equal(
      await w.JobsControlFields.chooseSpec(
        input,
        w.JobsProfileAnswers.knownSpec("Field of study", "Physics"),
      ),
      null,
    );
    const row = reader.scan().find((row) => row.node === input);
    assert.equal(row.public.invalid, false, "unanswered, not a wrong choice");
    assert.equal(reader.state().ready, true);
  } finally {
    w.close();
  }
});

test("in a run, a Profile answer an optional field could not take goes on the card instead of blocking or staying silent", async () => {
  const { w, doc } = page(
    '<label>Field of Study<select id="major"><option value="">Select</option><option>Chemistry</option></select></label><button id="next">Next</button>',
  );
  w.chrome = {
    runtime: {
      sendMessage: async (message) =>
        message.type === "jobs:tab-profile"
          ? { data: { id: "p", profile: {} } }
          : { data: { answers: [] } },
    },
  };
  for (const name of [
    "review-presenter",
    "ai-review",
    "operation-context",
    "automatic-fill",
  ])
    w.eval(await read("src/custom/" + name + ".js"));
  const notes = [];
  w.JobsDiagnostics = {
    note: (type, node, detail) => notes.push([type, detail]),
    trace() {},
  };
  try {
    const done = await w.JobsAutomatic.advance({
      root: doc.querySelector("form"),
      profile: {},
      action: "fill",
      resolveAnswers: async () => [],
      fill: () =>
        w.JobsFormPipeline.bind([
          {
            name: "major",
            find: () => doc.getElementById("major"),
            answer: "Physics",
          },
        ]),
    });
    assert.equal(done, false, "waits for the person");
    assert(w.JobsAIReview.pending());
    assert(
      notes.some(
        ([type, detail]) =>
          type === "auto_needs_input" && /did not match/.test(detail),
      ),
    );
  } finally {
    w.close();
  }
});
