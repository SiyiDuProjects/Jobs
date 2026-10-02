import test from "node:test";
import assert from "node:assert/strict";
import { adapterPage, profile } from "./helpers/adapter-run.mjs";
import { tagFixture } from "./helpers/tag-fixtures.mjs";
const plain = (value) => JSON.parse(JSON.stringify(value));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, message) {
  for (let i = 0; i < 300; i++) {
    if (read()) return;
    await delay(10);
  }
  assert.fail(message);
}

test("sign-in fields are filled outside a run: text by CSS, XPath or function, a choice spec and a check; a missing field is skipped", async (t) => {
  const p = await adapterPage(t, {
    html: `<form><label>Email<input id="email"></label><label>Code<input id="code"></label>
    <label>Country<select id="country"><option value="">Select</option><option>Canada</option><option>United States</option></select></label>
    <label><input type="checkbox" id="terms">Keep me signed in</label></form>`,
  });
  await p.w.jobsFillAccount([
    { find: "#email", value: "applicant@example.test" },
    { find: "//input[@id='code']", value: "fixture-value" },
    {
      find: () => p.doc.getElementById("country"),
      spec: p.w.JobsProfileAnswers.countrySpec("United States"),
    },
    { find: "#terms", checked: true },
    { find: "#missing", value: "ignored" },
  ]);
  assert.equal(p.value("#email"), "applicant@example.test");
  assert.equal(p.value("#code"), "fixture-value");
  assert.equal(p.value("#country"), "United States");
  assert.equal(p.doc.getElementById("terms").checked, true);
  assert.deepEqual(p.phases, [], "no run, rules or AI take part in sign-in");
});

test("a step navigates to Next, or submits on the last step, only when the person's settings allow it", async (t) => {
  const p = await adapterPage(t, {
    html: '<form><button id="next">Next</button><button id="submit">Submit</button></form>',
  });
  const step = (settings) =>
    plain(p.w.jobsStepNavigation(settings, "#next", "#submit"));
  assert.deepEqual(step({ autoClickNextPage: true }), {
    action: "next",
    selector: "#next",
  });
  assert.deepEqual(step({ autoClickNextPage: false, autoSubmit: true }), {
    action: "fill",
    selector: "#next",
  });
  p.doc.getElementById("next").remove();
  assert.deepEqual(step({ autoSubmit: true }), {
    action: "submit",
    selector: "#submit",
  });
  assert.deepEqual(step({ autoSubmit: false, autoClickNextPage: true }), {
    action: "fill",
    selector: "#submit",
  });
});

test("a checked binding sets a custom checkbox through its row setter and a native radio through its own choice", async (t) => {
  const p = await adapterPage(t, {
    html: `<form><div role="checkbox" id="agree" aria-checked="false" tabindex="0" aria-label="I agree to the terms"></div>
    <fieldset><legend>Preferred contact</legend><label><input type="radio" name="contact" value="email">Email</label><label><input type="radio" name="contact" value="phone">Phone</label></fieldset></form>`,
  });
  p.doc.getElementById("agree").addEventListener("click", (event) => {
    const node = event.currentTarget;
    node.setAttribute(
      "aria-checked",
      String(node.getAttribute("aria-checked") !== "true"),
    );
  });
  await p.fill((w) =>
    w.JobsFormPipeline.bind([
      { name: "agree", find: "#agree", checked: true },
      { name: "contact", find: "//input[@value='phone']", checked: true },
    ]),
  );
  assert.equal(
    p.doc.getElementById("agree").getAttribute("aria-checked"),
    "true",
  );
  assert.deepEqual(p.checked('input[name="contact"]'), ["phone"]);
  for (const name of ["agree", "contact"])
    assert(
      p.traces.some((entry) => entry.decider === "binding:" + name),
      name + " has its binding as decider",
    );
  // A second fill keeps what the page already holds rather than toggling it off.
  await p.fill((w) =>
    w.JobsFormPipeline.bind([{ name: "agree", find: "#agree", checked: true }]),
  );
  assert.equal(
    p.doc.getElementById("agree").getAttribute("aria-checked"),
    "true",
  );
});

test("a free-text tag is its own option: the rule accepts the query or nothing is added", async () => {
  const f = tagFixture("seek");
  try {
    f.open();
    assert.equal(
      await f.controls.chooseFrom(
        f.editor,
        (labels) => (labels.includes("Rust") ? null : labels[0]),
        { query: "Rust" },
      ),
      null,
    );
    assert.deepEqual(plain(f.controls.value(f.editor)), []);
    assert.equal(
      await f.window.JobsControlFields.chooseSpec(
        f.editor,
        f.window.JobsProfileAnswers.skillSpec("Python"),
      ),
      f.editor,
    );
    assert.deepEqual(plain(f.controls.value(f.editor)), ["Python"]);
    assert.equal(
      await f.window.JobsControlFields.chooseSpec(
        f.editor,
        f.window.JobsProfileAnswers.skillSpec("C++"),
      ),
      f.editor,
      "a skill is appended",
    );
    assert.deepEqual(plain(f.controls.value(f.editor)), ["Python", "C++"]);
  } finally {
    f.close();
  }
});

test("Indeed demographic questions run as one page run: ordinary privacy consent and Profile rules, with no navigation", async (t) => {
  const p = await adapterPage(t, {
    site: "indeed",
    url: "https://smartapply.indeed.com/beta/indeedapply/form/demographic-questions/1",
    html: `<main><form>
    <div class="ia-Questions-item"><fieldset><legend>Gender</legend><label><input type="radio" name="gender" value="Female">Female</label><label><input type="radio" name="gender" value="Male">Male</label></fieldset></div>
    <div class="ia-Questions-item"><label><input type="checkbox" name="consent" required>I agree to the privacy policy for processing my personal data</label></div>
    <button type="button" id="continue">Continue</button></form></main>`,
  });
  let clicks = 0;
  p.doc.getElementById("continue").addEventListener("click", () => clicks++);
  const phases = [];
  p.w.indeedRunApplication({
    setMessage: (message) => phases.push(message),
    getProfile: async () => profile,
    autofillSettings: { saveResponses: false, saveApplications: false },
    ctx: { addEventListener() {} },
  });
  await until(
    () =>
      p.checked('input[name="gender"]').length &&
      p.doc.querySelector('input[name="consent"]').checked,
    "the run did not fill the page",
  );
  assert.deepEqual(p.checked('input[name="gender"]'), ["Male"]);
  assert(
    p.traces.some((entry) => entry.decider === "rule"),
    "the consent answer is decided by the shared rule",
  );
  // The run ends with the page filled and no continuation of its own.
  await until(
    () =>
      phases.length > 1 &&
      !["in-progress", "checking", "ai-thinking", "ai-filling"].includes(
        phases.at(-1),
      ),
    "the run did not end",
  );
  assert.equal(clicks, 0, "the person continues");
});

test("the Indeed review page names the job that is recorded once the application is sent", async (t) => {
  const p = await adapterPage(t, {
    site: "indeed",
    url: "https://smartapply.indeed.com/beta/indeedapply/form/review",
    html: '<div class="ia-JobHeader"><h1>Research Engineer</h1><span>Example Labs - Boston, MA</span></div><script>window.data={"jk":"abc123"}</script>',
  });
  assert.deepEqual(plain(p.w.indeedReadAttempt("https://www.indeed.com")), {
    jobTitle: "Research Engineer",
    jobLink: "https://www.indeed.com/viewjob?jk=abc123",
    companyName: "Example Labs",
    companyLink: "https://www.indeed.com/cmp/Example-Labs",
  });
  p.doc.querySelector("script").remove();
  assert.equal(
    p.w.indeedReadAttempt("https://www.indeed.com"),
    undefined,
    "without the job key nothing is recorded",
  );
});
