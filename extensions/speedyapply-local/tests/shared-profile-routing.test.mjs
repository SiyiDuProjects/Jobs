import test from "node:test";
import assert from "node:assert/strict";
import { adapterPage, profile } from "./helpers/adapter-run.mjs";

const facts = {
  ...profile,
  applicationData: { sponsorshipNow: false, sponsorshipFuture: true },
};
const controls = [
  ["name", "Please state your full legal name:", '<input id="name" required>'],
  ["work", "Are you authorized to work in the United States?", choices("work")],
  [
    "sponsor",
    "Will you require sponsorship for employment now or in the future?",
    choices("sponsor"),
  ],
  [
    "graduation",
    "What is your expected graduation year?",
    '<input id="graduation" required>',
  ],
];
function choices(id) {
  return `<select id="${id}" required><option value="">Select</option><option>Yes</option><option>No</option></select>`;
}
const platforms = [
  [
    "lever",
    "https://jobs.lever.co/example/role/apply",
    (id, q, control) =>
      `<li class="application-question"><div class="application-label"><div class="text">${q}<span class="required">✱</span></div></div><div class="application-field">${control}</div></li>`,
  ],
  [
    "greenhouse",
    "https://job-boards.greenhouse.io/example/jobs/123",
    (id, q, control) =>
      `<div class="field"><label for="${id}">${q}</label>${control}</div>`,
  ],
  [
    "ashby",
    "https://jobs.ashbyhq.com/example/role/application",
    (id, q, control) =>
      `<div class="ashby-application-form-field-entry"><label for="${id}">${q}</label>${control}</div>`,
  ],
  [
    "workday",
    "https://example.wd1.myworkdayjobs.com/en-US/Careers/job/Example/Role_R1/apply",
    (id, q, control) =>
      `<div data-automation-id="formField-${id}"><label for="${id}">${q}</label>${control}</div>`,
  ],
  [
    "icims",
    "https://careers-example.icims.com/jobs/1/role/apply",
    (id, q, control) =>
      `<div class="iCIMS_FieldRow"><label for="${id}">${q}</label>${control}</div>`,
  ],
];
for (const [site, url, field] of platforms)
  for (const withGap of [false, true])
    test(`${site}: known questions fill with the answer service offline${withGap ? "; only the unknown field is delegated" : " and no answer request"}`, async (t) => {
      const html = `<form id="application-form"><div data-qa="additional-cards">${controls.map((args) => field(...args)).join("")}${withGap ? field("unknown", "Describe an example of resolving a technical disagreement", '<textarea id="unknown" required></textarea>') : ""}</div></form>`;
      const h = await adapterPage(t, { site, url, html });
      const send = h.w.chrome.runtime.sendMessage;
      const requested = [];
      h.w.chrome.runtime.sendMessage = async (message) => {
        if (message.type === "jobs:auto-answers") {
          requested.push(
            ...message.fields.map((f) => f.question.replace(/[\s✱*]+$/g, "")),
          );
          throw Error("Synthetic answer service offline");
        }
        return send(message);
      };
      await h.fill(() => null, { current: facts });
      assert.equal(h.value("#name"), "Example Applicant");
      assert.equal(h.value("#work"), "Yes");
      assert.equal(h.value("#sponsor"), "Yes");
      assert.equal(h.value("#graduation"), "2025");
      assert.deepEqual(
        requested,
        withGap
          ? ["Describe an example of resolving a technical disagreement"]
          : [],
      );
      for (const id of ["name", "work", "sponsor", "graduation"])
        assert(
          h.traces.some(
            (trace) =>
              trace.node?.id === id &&
              trace.source === "rule" &&
              trace.result === "decided",
          ),
          id,
        );
    });

test("Lever radio groups use shared answers while existing person input is retained", async (t) => {
  const [, url, field] = platforms[0];
  const radios = (id) =>
    `<ul>${["Yes", "No"].map((value) => `<li><label><input type="radio" name="${id}" value="${value}" required>${value}</label></li>`).join("")}</ul>`;
  const h = await adapterPage(t, {
    site: "lever",
    url,
    html: `<form id="application-form"><div data-qa="additional-cards">${controls.map(([id, q, control]) => field(id, q, ["work", "sponsor"].includes(id) ? radios(id) : control)).join("")}</div></form>`,
  });
  h.doc.querySelector("#name").value = "Person's current edit";
  await h.fill((w, canProceed) => w.leverFillApplication(facts, canProceed), {
    current: facts,
  });
  assert.equal(h.value("#name"), "Person's current edit");
  assert.deepEqual(h.checked('[name="work"]'), ["Yes"]);
  assert.deepEqual(h.checked('[name="sponsor"]'), ["Yes"]);
  assert.equal(h.value("#graduation"), "2025");
  assert.equal(h.requests.length, 0);
});
