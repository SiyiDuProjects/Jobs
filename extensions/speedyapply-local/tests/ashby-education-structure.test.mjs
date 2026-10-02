import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import { runAnswerStage } from "./helpers/answer-stage.mjs";
import { installAnswerResolver } from "./helpers/answer-resolver.mjs";

const source = (
  await Promise.all(
    ["dom-wait", "control-fields", "ashby-controls"].map((name) =>
      readWithDependencies(
        new URL(`../src/custom/${name}.js`, import.meta.url),
        "utf8",
      ),
    ),
  )
).join("\n");
const title = (label, required = false, target = "") =>
  `<label class="ashby-application-form-question-title ${required ? "_required_fixture_91" : ""}" for="${target}">${label}</label>`;
const dates = (
  name,
) => `<div>${title(`${name} Date`, false, `education-${name}`)}
  <div id="education-${name}"><div><select><option value="" disabled selected>Month...</option><option value="05">May</option><option value="08">August</option></select></div>
  <div><select><option value="" disabled selected>Year...</option><option>2024</option><option>2025</option><option>2027</option><option>2028</option></select></div></div></div>`;
const education = (
  i,
) => `<div class="ashby-application-form-input-education-entry">
  <div><div>${title("School", true, `school-${i}`)}<div><input role="combobox" placeholder="Search schools..." aria-expanded="false"><button type="button">Toggle</button></div></div>
  <div><div>${title("Degree", false, `degree-${i}`)}<input id="degree-${i}"></div><div>${title("Field of Study", false, `major-${i}`)}<input id="major-${i}"></div></div>
  <div>${dates("Start")}<div>${dates("End")}<label class="ashby-application-form-question-title" for="current-${i}"><span><input type="checkbox" id="current-${i}"></span>Still Student?</label></div></div></div></div>`;

function fixture(count = 1) {
  const dom = new JSDOM(
    `<form><div class="ashby-application-form-field-entry">${title("Education History", true)}<div>${Array.from({ length: count }, (_, i) => education(i)).join("")}</div></div>
    <fieldset>${title("What is your preferred programming language for interviews?", true)}<div><input role="combobox"><button type="button">Toggle</button></div></fieldset>
    <fieldset>${title("Optional source")}<div><input role="combobox"><button type="button">Toggle</button></div></fieldset></form>`,
    {
      url: "https://jobs.ashbyhq.com/fixture/application",
      runScripts: "outside-only",
    },
  );
  dom.window.eval(source);
  const doc = dom.window.document;
  return {
    dom,
    doc,
    reader: dom.window.JobsControlFields.create(doc, () =>
      doc.querySelector("form"),
    ),
  };
}

test("live Ashby nested structure preserves child questions and their own required markers", () => {
  const f = fixture();
  try {
    const rows = f.reader.scan();
    assert.deepEqual(
      Array.from(rows, (r) => [r.public.question, r.public.required]),
      [
        ["School", true],
        ["Degree", false],
        ["Field of Study", false],
        ["Education Start Month", false],
        ["Education Start Year", false],
        ["Education End Month", false],
        ["Education End Year", false],
        ["Still Student?", false],
        ["What is your preferred programming language for interviews?", true],
        ["Optional source", false],
      ],
    );
    for (const select of f.doc.querySelectorAll('[id="education-End"] select'))
      select.disabled = true;
    assert.equal(
      f.reader.scan().filter((r) => /Education End/.test(r.public.question))
        .length,
      0,
    );
  } finally {
    f.dom.window.close();
  }
});

test("two education entries resolve their own facts and start/end months through the one answer stage", async () => {
  const f = fixture(2);
  try {
    // Synthetic option widget: opening exposes options, selecting commits and closes.
    f.doc
      .querySelectorAll(
        '.ashby-application-form-input-education-entry input[role="combobox"]',
      )
      .forEach((input, i) => {
        input.nextElementSibling.addEventListener("click", () => {
          const old = f.doc.getElementById(`schools-${i}`);
          if (old) {
            old.remove();
            input.setAttribute("aria-expanded", "false");
            return;
          }
          const list = f.doc.createElement("div");
          list.id = `schools-${i}`;
          list.setAttribute("role", "listbox");
          for (const school of [
            "Fixture Alpha University",
            "Fixture Beta College",
          ]) {
            const option = f.doc.createElement("div");
            option.setAttribute("role", "option");
            option.textContent = school;
            option.addEventListener("click", () => {
              input.value = school;
              input.setAttribute("aria-expanded", "false");
              list.remove();
            });
            list.append(option);
          }
          input.setAttribute("aria-controls", list.id);
          input.setAttribute("aria-expanded", "true");
          input.parentElement.append(list);
        });
      });
    const resolveAnswers = installAnswerResolver(f.dom.window);
    await runAnswerStage(f.dom.window, {
      root: f.doc.querySelector("form"),
      resolveAnswers,
      profile: {
        educationData: [
          {
            school: "Fixture Alpha University",
            degree: "Bachelor of Arts",
            fieldOfStudy: "Physics",
            startDate: "2024-08",
            endDate: "2027-05",
            currentlyAttending: true,
          },
          {
            school: "Fixture Beta College",
            degree: "Bachelor of Science",
            fieldOfStudy: "Mathematics",
            startDate: "2025-05",
            endDate: "2028-08",
            currentlyAttending: true,
          },
        ],
      },
    });
    assert.deepEqual(
      [
        ...f.doc.querySelectorAll(
          '.ashby-application-form-input-education-entry input[role="combobox"]',
        ),
      ].map((n) => n.value),
      ["Fixture Alpha University", "Fixture Beta College"],
    );
    assert.deepEqual(
      [...f.doc.querySelectorAll("select")].map((n) => n.value),
      ["08", "2024", "05", "2027", "05", "2025", "08", "2028"],
    );
    assert.equal(f.doc.getElementById("major-1").value, "Mathematics");
    assert.equal(f.doc.getElementById("current-0").checked, true);
    assert.equal(f.doc.getElementById("current-1").checked, true);
  } finally {
    f.dom.window.close();
  }
});

test("missing optional education dates abstain instead of becoming required AI questions", async () => {
  const f = fixture();
  try {
    const rows = f.reader.scan();
    const questions = rows
      .filter((row) => /Education (Start|End)/.test(row.public.question))
      .map((row) => ({ ...row.public, fieldId: row.public.id }));
    const resolve = installAnswerResolver(f.dom.window);
    const answers = await resolve(
      questions,
      { educationData: [{ school: "Fixture University" }] },
      { root: f.doc.querySelector("form") },
    );
    assert.equal(answers.length, 0);
    for (const question of questions) {
      assert.equal(question.required, false);
      assert.equal(f.dom.window.JobsControlFields.needsAnswer(question), false);
    }
    const language = rows.find((row) =>
      /preferred programming language/.test(row.public.question),
    );
    assert.equal(
      f.dom.window.JobsControlFields.needsAnswer(language.public),
      true,
    );
  } finally {
    f.dom.window.close();
  }
});
