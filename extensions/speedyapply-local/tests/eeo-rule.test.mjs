import { readWithDependencies } from "./helpers/runtime-source.mjs";
// One EEO rule for every ATS: the site vocabularies the adapters used to map by
// hand must still produce the same option, from the shared rule.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { functionBlock } from "./helpers/menu-fixtures.mjs";

const read = (path) =>
  readWithDependencies(
    new URL("../src/custom/" + path + ".js", import.meta.url),
    "utf8",
  );
const c = vm.createContext({});
vm.runInContext(
  (await read("option-match")) + "\n" + (await read("profile-answers")),
  c,
);
const { JobsProfileAnswers: rules, JobsOptionMatch: match } = c;
const pick = (topic, employment, labels) =>
  match.pick(labels, rules.eeoSpec(topic, employment) ?? { tiers: [] })
    ?.label ?? null;

const decline = {
  greenhouse: "Decline To Self Identify",
  lever: "Decline to self-identify",
  workday: "I do not wish to answer",
  ashby: "Decline to self-identify",
};
const race = {
  greenhouse: [
    "American Indian or Alaskan Native",
    "Asian",
    "Black or African American",
    "Hispanic or Latino",
    "Native Hawaiian or Other Pacific Islander",
    "White",
    "Two or More Races",
    "Decline To Self Identify",
  ],
  lever: [
    "American Indian or Alaska Native (Not Hispanic or Latino)",
    "Asian (Not Hispanic or Latino)",
    "Black or African American (Not Hispanic or Latino)",
    "Hispanic or Latino",
    "Native Hawaiian or Other Pacific Islander (Not Hispanic or Latino)",
    "White (Not Hispanic or Latino)",
    "Two or More Races (Not Hispanic or Latino)",
    "Decline to self-identify",
  ],
  workday: [
    "American Indian or Alaska Native (United States of America)",
    "Asian (United States of America)",
    "Black or African American (United States of America)",
    "Hispanic or Latino (United States of America)",
    "Native Hawaiian or Other Pacific Islander (United States of America)",
    "White (United States of America)",
    "Two or More Races (United States of America)",
    "I do not wish to answer",
  ],
  ashby: [
    "American Indian or Alaska Native",
    "Asian",
    "Black or African American",
    "Hispanic or Latino",
    "Native Hawaiian or Other Pacific Islander",
    "White",
    "Two or More Races",
    "Decline to self-identify",
  ],
};

test("race: every ethnicity lands on the same site option the old tables chose", () => {
  for (const [site, labels] of Object.entries(race)) {
    const expect = [
      ["American Indian or Alaska Native", 0],
      ["Asian", 1],
      ["Black or African American", 2],
      ["Hispanic or Latino", 3],
      ["Native Hawaiian or Other Pacific Islander", 4],
      ["White", 5],
      ["I choose not to disclose", 7],
      ["", 7],
    ];
    for (const [ethnicity, index] of expect)
      assert.equal(
        pick("race", { ethnicity, hispanicOrLatino: false }, labels),
        labels[index],
        `${site} ${ethnicity || "(empty)"}`,
      );
    // Hispanic/Latino identity wins over another stored ethnicity (jobsResolveEthnicityAnswer).
    assert.equal(
      pick("race", { ethnicity: "White", hispanicOrLatino: true }, labels),
      labels[3],
      site,
    );
  }
});

test("gender, Hispanic/Latino, disability and veteran follow the Profile on every site vocabulary", () => {
  for (const [site, no] of Object.entries(decline)) {
    const gender = ["Male", "Female", no],
      hispanic = ["Yes", "No", no];
    const disability = [
      "Yes, I have a disability, or have had one in the past",
      "No, I do not have a disability and have not had one in the past",
      no,
    ];
    assert.equal(pick("gender", { gender: "Male" }, gender), "Male", site);
    assert.equal(pick("gender", { gender: "Female" }, gender), "Female", site);
    assert.equal(
      pick("gender", { gender: "I choose not to disclose" }, gender),
      no,
      site,
    );
    assert.equal(pick("gender", { gender: "Non-Binary" }, gender), no, site);
    assert.equal(pick("hispanic", { hispanicOrLatino: true }, hispanic), "Yes");
    assert.equal(
      pick(
        "hispanic",
        { ethnicity: "Asian", hispanicOrLatino: false },
        hispanic,
      ),
      "No",
    );
    assert.equal(
      pick("hispanic", { ethnicity: "I choose not to disclose" }, hispanic),
      no,
      site,
    );
    assert.equal(
      pick("disability", { disability: true }, disability),
      disability[0],
    );
    assert.equal(
      pick("disability", { disability: false }, disability),
      disability[1],
    );
    assert.equal(
      pick("disability", { disability: "undisclosed" }, disability),
      no,
      site,
    );
  }
  const veteran = [
    "I am not a veteran",
    "I identify as one or more of the classifications of protected veteran",
    "I am a veteran but not a protected veteran",
    "I do not wish to answer",
  ];
  assert.equal(
    pick("veteran", { veteran: false }, veteran),
    "I am not a veteran",
  );
  assert.equal(
    pick("veteran", { veteran: "undisclosed" }, veteran),
    "I do not wish to answer",
  );
  assert.equal(
    rules.eeoSpec("veteran", { veteran: true }),
    null,
    "a veteran classification is left for the owner",
  );
  assert.equal(
    pick("gender", { gender: "Male" }, ["Female", "Woman", "Decline"]),
    null,
    "Male never matches Female",
  );
});

test("unknown or ambiguous EEO facts are never guessed", () => {
  // Explicit legacy empty choices mean decline; a missing fact is not consent.
  assert.equal(
    pick("disability", { disability: "" }, [
      "Yes",
      "No",
      "I do not want to answer",
    ]),
    "I do not want to answer",
  );
  assert.equal(
    pick("disability", {}, ["Yes", "No", "I do not want to answer"]),
    null,
  );
  assert.equal(pick("hispanic", {}, ["Yes", "No", "Decline"]), null);
  assert.equal(
    pick("hispanic", { ethnicity: "Asian" }, ["Yes", "No", "Decline"]),
    null,
  );
  assert.equal(pick("race", {}, ["Asian", "Decline"]), null);
  assert.equal(
    pick("race", { ethnicity: "Asian" }, ["South Asian", "Decline"]),
    null,
    "a single subtype is still unconfirmed",
  );
  assert.equal(
    pick("race", { ethnicity: "Asian" }, ["Asian (Not Hispanic or Latino)"]),
    null,
    "the second identity needs its own fact",
  );
  assert.equal(
    pick("gender", { gender: "Male" }, ["Transgender Male", "Decline"]),
    null,
  );
  assert.equal(
    pick("gender", { gender: "I choose not to disclose" }, [
      "I wish to answer",
      "Male",
    ]),
    null,
  );
  assert.equal(
    pick("race", { ethnicity: "Asian" }, [
      "East Asian",
      "South Asian",
      "Decline",
    ]),
    null,
    "two Asian subgroups: refuse",
  );
  assert.equal(
    pick("race", { ethnicity: "American Indian or Alaska Native" }, [
      "Alaskan Native",
      "Decline",
    ]),
    null,
  );
  assert.equal(
    pick("race", { ethnicity: "Native Hawaiian or Other Pacific Islander" }, [
      "Native Hawaiian",
      "Decline",
    ]),
    null,
  );
  assert.equal(
    pick("hispanic", { hispanicOrLatino: true }, [
      "I do not wish to answer",
      "Not Hispanic",
    ]),
    null,
  );
});

test("split and combined ethnicity questions use only their confirmed identity facts", () => {
  const employmentData = { ethnicity: "Asian", hispanicOrLatino: true };
  assert.equal(
    pick("race", employmentData, ["Asian", "White", "Hispanic or Latino"]),
    "Hispanic or Latino",
  );
  assert.equal(
    pick("race", employmentData, ["Asian", "White"]),
    "Asian",
    "split race still has a known answer",
  );
  assert.equal(
    pick("ethnicity", employmentData, [
      "Hispanic or Latino",
      "Not Hispanic or Latino",
    ]),
    "Hispanic or Latino",
  );
  const nonHispanic = { ethnicity: "Asian", hispanicOrLatino: false };
  assert.equal(
    pick("ethnicity", nonHispanic, [
      "Hispanic or Latino",
      "Not Hispanic or Latino",
    ]),
    "Not Hispanic or Latino",
  );
  assert.equal(
    pick("ethnicity", nonHispanic, ["Asian", "White", "Hispanic or Latino"]),
    "Asian",
  );
  assert.equal(
    rules.resolve("Ethnicity", { employmentData: nonHispanic }).answer,
    "Asian",
    "free text is a category, not the boolean No",
  );
  assert.equal(
    pick("ethnicity", { ethnicity: "Asian" }, [
      "Hispanic or Latino",
      "Not Hispanic or Latino",
    ]),
    null,
  );
});

test("the shared entrance chooses a radio option by its label (Ashby, Lever)", async () => {
  const dom = new JSDOM(
    `<form>
    <span><input type="radio" id="g1" name="_systemfield_eeoc_gender"></span><label for="g1">Male</label>
    <span><input type="radio" id="g2" name="_systemfield_eeoc_gender"></span><label for="g2">Female</label>
    <span><input type="radio" id="g3" name="_systemfield_eeoc_gender"></span><label for="g3">Decline to self-identify</label></form>`,
    {
      url: "https://jobs.ashbyhq.com/acme/job/application",
      runScripts: "outside-only",
    },
  );
  const w = dom.window;
  for (const name of [
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
  ])
    w.eval(await read(name));
  try {
    assert(
      await w.JobsControlFields.chooseSpec(
        w.document.getElementById("g1"),
        w.JobsProfileAnswers.eeoSpec("gender", { gender: "Female" }),
      ),
    );
    assert.equal(w.document.getElementById("g2").checked, true);
    assert.equal(w.document.getElementById("g1").checked, false);
    // An existing choice is kept unless replaced.
    assert.equal(
      await w.JobsControlFields.chooseSpec(
        w.document.getElementById("g1"),
        w.JobsProfileAnswers.eeoSpec("gender", { gender: "Male" }),
      ),
      null,
    );
    assert.equal(w.document.getElementById("g2").checked, true);
  } finally {
    w.close();
  }
});

test("first fill and supplement share the EEO rule, and AI/remote writes commit its exact option", async () => {
  const examples = [
    [
      "Race",
      "race",
      { ethnicity: "Asian", hispanicOrLatino: false },
      race.lever,
    ],
    [
      "Race",
      "race",
      { ethnicity: "Asian" },
      ["South Asian", "East Asian", "Decline"],
    ],
    [
      "Gender",
      "gender",
      { gender: "Non-Binary" },
      ["Male", "Female", "Nonbinary", "Decline"],
    ],
    [
      "Disability",
      "disability",
      { disability: false },
      [
        "Yes, I have a disability",
        "No, I do not have a disability",
        "I do not wish to answer",
      ],
    ],
    [
      "Are you Hispanic or Latino?",
      "hispanic",
      { hispanicOrLatino: true },
      ["Yes", "No", "Decline"],
    ],
    [
      "Veteran status",
      "veteran",
      { veteran: false },
      ["I am not a veteran.", "Prefer not to say"],
    ],
  ];
  for (const [question, topic, employmentData, labels] of examples) {
    const dom = new JSDOM(
        "<form><label>" +
          question +
          '<select required><option value="">Select...</option>' +
          labels
            .map((label, i) => `<option value="v${i}">${label}</option>`)
            .join("") +
          "</select></label></form>",
        {
          url: "https://jobs.lever.co/example/role/apply",
          runScripts: "outside-only",
        },
      ),
      w = dom.window;
    for (const name of [
      "option-match",
      "profile-answers",
      "dom-wait",
      "control-fields",
    ])
      w.eval(await read(name));
    const traces = [];
    w.JobsDiagnostics = {
      note() {},
      trace: (_node, value) => traces.push(value),
    };
    try {
      const node = w.document.querySelector("select");
      await w.JobsControlFields.chooseSpec(
        node,
        w.JobsProfileAnswers.eeoSpec(topic, employmentData),
      );
      const first = node.value ? node.selectedOptions[0].text : null;
      const answer = w.JobsProfileAnswers.select(
        w.JobsProfileAnswers.resolve(
          question,
          { employmentData },
          { options: labels },
        ),
        labels,
      );
      assert.equal(first, answer, question);
      if (answer) {
        const trace = traces.find(
          (row) => row.source === "adapter" && row.result === "committed",
        );
        assert.deepEqual(Array.from(trace.options), labels);
        assert.equal(trace.method, "exact");
        for (const source of ["known", "ai", "remote"]) {
          node.value = "";
          const reader = w.JobsControlFields.create(
            w.document,
            () => w.document.querySelector("form"),
            { write: true },
          );
          const row = reader.scan()[0];
          await reader.apply(
            row,
            row.public.options.find((option) => option.label === answer).value,
            () => true,
            { source },
          );
          assert.equal(node.selectedOptions[0].text, answer, source);
        }
      }
    } finally {
      w.close();
    }
  }
});

test("choice specs isolate form and input type, honor cancellation, and replace one checkbox choice", async () => {
  const dom = new JSDOM(
      '<form id="a"><label>Male<input name="gender" type="checkbox" checked></label><label>Female<input id="female" name="gender" type="checkbox"></label><label>Female<input name="gender" type="radio"></label></form><form><label>Female<input name="gender" type="checkbox"></label></form>',
      { runScripts: "outside-only" },
    ),
    w = dom.window;
  for (const name of [
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
  ])
    w.eval(await read(name));
  try {
    const node = w.document.getElementById("female"),
      spec = w.JobsProfileAnswers.eeoSpec("gender", { gender: "Female" });
    assert.equal(
      await w.JobsControlFields.chooseSpec(node, spec, {
        replace: true,
        canProceed: () => false,
      }),
      null,
    );
    assert.equal(w.document.querySelector("input").checked, true);
    assert(await w.JobsControlFields.chooseSpec(node, spec, { replace: true }));
    assert.deepEqual(
      [...w.document.querySelectorAll("input")].map((input) => input.checked),
      [false, true, false, false],
    );
    w.JobsOptionMatch = null;
    assert.equal(
      await w.JobsControlFields.chooseSpec(null, spec),
      null,
      "missing page fields do not consult the matcher",
    );
  } finally {
    w.close();
  }
});

test("the real Lever additional questionnaire keeps choices inside their own question", async () => {
  const questions = [
    [
      "race",
      "Race / ethnicity",
      ["Asian", "White / Caucasian", "Prefer not to say"],
    ],
    ["gender", "Gender", ["Male", "Female", "Non-binary", "Prefer not to say"]],
    ["disability", "Disability", ["Yes", "No", "Prefer not to say"]],
    ["unrelated", "Another question", ["Yes", "No"]],
  ];
  const html = questions
    .map(
      ([name, title, labels]) =>
        `<section><div><div class="text">${title}</div></div><div><ul>${labels.map((label) => `<li><label><input type="checkbox" name="${name}" value="${label}"><span>${label}</span></label></li>`).join("")}</ul></div></section>`,
    )
    .join("");
  const dom = new JSDOM("<form>" + html + "</form>", {
      url: "https://jobs.lever.co/example/role/apply",
      runScripts: "outside-only",
    }),
    w = dom.window;
  for (const name of [
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
    "form-pipeline",
  ])
    w.eval(await read(name));
  w.jobsFindXPath = (path) =>
    w.document.evaluate(
      path,
      w.document,
      null,
      w.XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    ).singleNodeValue;
  w.jobsLowercaseXPath = (value) =>
    `translate(${value}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
  w.eval(
    await readWithDependencies(
      new URL("../source/content/adapters/lever.js", import.meta.url),
      "utf8",
    ),
  );
  try {
    await w.leverFillAdditionalDisclosures({
      addressData: { country: "United States" },
      employmentData: {
        gender: "Non-Binary",
        ethnicity: "Asian",
        disability: false,
      },
    });
    assert.deepEqual(
      [...w.document.querySelectorAll("input:checked")].map(
        (input) => input.value,
      ),
      ["Asian", "Non-binary", "No"],
    );
    await w.leverFillAdditionalDisclosures({
      addressData: { country: "United States" },
      employmentData: {
        gender: "Female",
        ethnicity: "White",
        disability: true,
      },
    });
    assert.deepEqual(
      [...w.document.querySelectorAll("input:checked")].map(
        (input) => input.value,
      ),
      ["Asian", "Non-binary", "No"],
      "a later automatic pass preserves current answers",
    );
  } finally {
    w.close();
  }
});
