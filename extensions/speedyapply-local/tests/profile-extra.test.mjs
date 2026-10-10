import test from "node:test";
import assert from "node:assert/strict";
import { extraProfileAnswer } from "../src/custom/profile-extra.js";
import { jobsFormatProfileDate } from "../source/content/shared/profile-format.js";
test("identity requires the explicit compound preset, independent of gender", () => {
  const p = { employmentData: { gender: "Male" } };
  assert.equal(extraProfileAnswer("Gender identity", p), null);
  p.employmentData.identityDefaults = "cis_heterosexual";
  assert.equal(extraProfileAnswer("Are you transgender?", p).answer, "No");
  assert.equal(
    extraProfileAnswer("Sexual orientation", p).answer,
    "Heterosexual",
  );
});
test("named employment absence applies only to an unqualified company question", () => {
  const p = { jobData: [] };
  assert.equal(
    extraProfileAnswer("Have you ever worked at Example?", p).answer,
    "No",
  );
  for (const q of [
    "Have you ever worked at Example or a subsidiary?",
    "Have you ever worked at Example since 2020?",
  ])
    assert.equal(extraProfileAnswer(q, p), null);
});
test("Freshteam exact-day formatting never creates day one from a month", () => {
  for (const date of ["2027-05", "2027-02-30", ""])
    assert.equal(jobsFormatProfileDate(date), undefined);
  assert.equal(jobsFormatProfileDate("2027-05-26"), "05/26/2027");
});

test("citizenship aliases are recognized and unknown countries never prove No", () => {
  for (const [citizenships, expected] of [
    [["美国"], "Yes"],
    [["United States of America"], "Yes"],
    [["China"], "No"],
    [["Unrecognized country"], null],
  ]) {
    assert.equal(
      extraProfileAnswer("Are you a US citizen?", {
        employmentData: { citizenships },
      })?.answer ?? null,
      expected,
    );
  }
});
