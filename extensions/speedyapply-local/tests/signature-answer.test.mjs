import test from "node:test";
import assert from "node:assert/strict";
import { signatureAnswer } from "../src/custom/signature-answer.js";
const profile = { nameData: { firstName: "Alex", lastName: "Example" } };
test("a declaration ending in a text signature uses name and the supplied current day", () => {
  const question =
    "i certify that these answers are accurate. signature and date";
  assert.equal(
    signatureAnswer(question, profile, { type: "textarea" }, "2026-10-07")
      .answer,
    "Alex Example — 2026-10-07",
  );
  assert.equal(
    signatureAnswer(question, profile, { type: "checkbox" }, "2026-10-07"),
    null,
  );
  assert.equal(
    signatureAnswer(question, {}, { type: "textarea" }, "2026-10-07").answer,
    null,
  );
});

test("separate signature and signing date fields retain their requested formats", () => {
  assert.equal(
    signatureAnswer(
      "i certify that the answers are correct. signature",
      profile,
      { type: "text" },
      "2026-10-07",
    ).answer,
    "Alex Example",
  );
  assert.equal(
    signatureAnswer("signature date", profile, { type: "date" }, "2026-10-07")
      .answer,
    "2026-10-07",
  );
  assert.equal(
    signatureAnswer(
      "expected graduation date",
      profile,
      { type: "date" },
      "2026-10-07",
    ),
    null,
  );
  assert.equal(
    signatureAnswer(
      "i certify that my signature is correct",
      profile,
      { type: "checkbox" },
      "2026-10-07",
    ),
    null,
  );
});
