import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JobsProfileContract } from "../src/custom/profile-contract.js";
const schema = JSON.parse(
  await fs.readFile(
    new URL(
      "../../../services/jobs-radar/jobs_radar/profile.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
test("each schema Profile root and projected child declares an explicit AI privacy policy", () => {
  const policies = schema["x-answerProjection"];
  assert.deepEqual(
    Object.keys(policies).sort(),
    Object.keys(schema.properties).sort(),
  );
  for (const [name, policy] of Object.entries(policies)) {
    assert(["include", "project", "exclude"].includes(policy.mode));
    if (policy.mode === "project")
      assert.deepEqual(
        [...policy.include, ...policy.exclude].sort(),
        Object.keys(schema.properties[name].properties).sort(),
      );
    if (policy.mode === "exclude") assert(policy.reason);
  }
});
test("schema-generated projection keeps confirmed facts and coarse location and excludes binaries and contact", () => {
  const profile = {
    profileName: "Fixture",
    nameData: { firstName: "Example" },
    addressData: {
      city: "City",
      state: "State",
      country: "United States",
      line1: "PRIVATE",
    },
    contactData: { email: "PRIVATE" },
    resumeData: { resumeBase64: "PRIVATE" },
    educationData: [{ endDate: "2027-05", graduationDate: "2027-05-17" }],
    applicationData: { sponsorshipNow: false, sponsorshipFuture: true },
  };
  const complete = Object.fromEntries(
    schema.required.map((key) => [
      key,
      schema.properties[key].type === "array" ? [] : {},
    ]),
  );
  const projected = JobsProfileContract.projectAnswerProfile({
    ...complete,
    ...profile,
  });
  assert.equal(projected.applicationData.sponsorshipNow, false);
  assert.equal(projected.educationData[0].graduationDate, "2027-05-17");
  assert.deepEqual(projected.addressData, {
    city: "City",
    state: "State",
    country: "United States",
  });
  assert.equal(projected.contactData, undefined);
  assert.equal(projected.resumeData, undefined);
  assert(!JSON.stringify(projected).includes("PRIVATE"));
});
