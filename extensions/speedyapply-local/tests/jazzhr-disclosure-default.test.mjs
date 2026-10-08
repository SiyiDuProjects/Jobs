import test from "node:test";
import assert from "node:assert/strict";
import { adapterPage, profile } from "./helpers/adapter-run.mjs";

const known = {
  ...profile,
  employmentData: {
    ...profile.employmentData,
    gender: "Female",
    ethnicity: "Asian",
    hispanicOrLatino: false,
  },
};
const form = (selected = "selected") => `<form>
  <label for="resumator-eeo_gender-value">Gender</label>
  <select id="resumator-eeo_gender-value">
    <option value="0" ${selected}>Decline to answer</option>
    <option value="1">Male</option><option value="2">Female</option>
  </select>
  <label for="resumator-eeo_race-value">Race</label>
  <select id="resumator-eeo_race-value">
    <option value="0" ${selected}>Decline to answer</option>
    <option value="1">White, not Hispanic or Latino</option>
    <option value="2">Asian, not Hispanic or Latino</option>
  </select></form>`;
const setup = async (
  t,
  { html = form(), host = "fixture.applytojob.com", late = false } = {},
) => {
  const p = await adapterPage(t, {
    site: "jazzhr",
    html: late ? html : "",
    url: `https://${host}/apply/fixture`,
  });
  if (!late) p.doc.body.innerHTML = html;
  return p;
};
const values = (p) =>
  [...p.doc.querySelectorAll("select")].map((n) => n.selectedOptions[0].text);
const fill = (p, current = known) =>
  p.fill((w) => w.jazzhrFillDisclosures(current.employmentData), { current });

for (const selected of ["selected", ""])
  test(`JazzHR replaces untouched default nondisclosure with Profile facts (${selected || "implicit"})`, async (t) => {
    const p = await setup(t, { html: form(selected) });
    await fill(p);
    assert.deepEqual(values(p), ["Female", "Asian, not Hispanic or Latino"]);
    assert.equal(p.requests.length, 0);
    assert.equal(
      p.traces.filter((entry) => entry.result === "committed").length,
      2,
    );
    // A second run cannot reinterpret an answer as the site's default.
    await fill(p, {
      ...known,
      employmentData: {
        gender: "Male",
        ethnicity: "White",
        hispanicOrLatino: false,
      },
    });
    assert.deepEqual(values(p), ["Female", "Asian, not Hispanic or Latino"]);
  });

test("a person changing back to decline before any scan retains that choice across runs and control replacement", async (t) => {
  const p = await setup(t);
  for (const node of p.doc.querySelectorAll("select")) {
    node.value = "2";
    node.dispatchEvent(new p.w.Event("change", { bubbles: true }));
    node.value = "0";
    node.dispatchEvent(new p.w.Event("change", { bubbles: true }));
  }
  await fill(p);
  assert.deepEqual(values(p), ["Decline to answer", "Decline to answer"]);
  for (const node of p.doc.querySelectorAll("select"))
    node.replaceWith(node.cloneNode(true));
  await fill(p);
  assert.deepEqual(values(p), ["Decline to answer", "Decline to answer"]);
  assert.equal(
    p.traces.some((entry) => entry.result === "committed"),
    false,
  );
});

test("restored non-default answers and other sites are preserved", async (t) => {
  const p = await setup(t);
  for (const node of p.doc.querySelectorAll("select")) node.value = "1";
  await fill(p);
  assert.deepEqual(values(p), ["Male", "White, not Hispanic or Latino"]);
  const other = await setup(t, { host: "fixture.example.com" });
  await fill(other);
  assert.deepEqual(values(other), ["Decline to answer", "Decline to answer"]);
});

test("late injection preserves existing refusal when prior interaction is unknown", async (t) => {
  const p = await setup(t, { late: true });
  await fill(p);
  assert.deepEqual(values(p), ["Decline to answer", "Decline to answer"]);
  assert.equal(
    p.traces.some((entry) => entry.result === "committed"),
    false,
  );
});

test("explicit Profile nondisclosure is retained and does not become a replaceable default in a later run", async (t) => {
  const p = await setup(t, {
    html: form().replaceAll(
      '<option value="0" selected>',
      '<option value="">Select...</option><option value="0">',
    ),
  });
  await fill(p, {
    ...known,
    employmentData: {
      gender: "I choose not to disclose",
      ethnicity: "I choose not to disclose",
    },
  });
  assert.deepEqual(values(p), ["Decline to answer", "Decline to answer"]);
  await fill(p);
  assert.deepEqual(values(p), ["Decline to answer", "Decline to answer"]);
});

test("a Profile-confirmed initial refusal stays protected after a Profile change", async (t) => {
  const p = await setup(t);
  await fill(p, {
    ...known,
    employmentData: {
      gender: "I choose not to disclose",
      ethnicity: "I choose not to disclose",
    },
  });
  await fill(p);
  assert.deepEqual(values(p), ["Decline to answer", "Decline to answer"]);
});

for (const value of [undefined, ""])
  test(`unknown Profile disclosures do not select decline (${String(value)})`, async (t) => {
    const p = await setup(t, {
      html: form().replaceAll(
        '<option value="0" selected>',
        '<option value="">Select...</option><option value="0">',
      ),
    });
    await fill(p, {
      ...known,
      employmentData: { gender: value, ethnicity: value },
    });
    assert.deepEqual(values(p), ["Select...", "Select..."]);
    assert.equal(
      p.traces.some((entry) => entry.result === "committed"),
      false,
    );
    assert.equal(p.requests.length, 1);
  });
