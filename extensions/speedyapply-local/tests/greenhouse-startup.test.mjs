import test from "node:test";
import assert from "node:assert/strict";
import { adapterPage, profile } from "./helpers/adapter-run.mjs";

const fields = `
  <label for="first_name">First Name*</label><input id="first_name" required>
  <label for="last_name">Last Name*</label><input id="last_name" required>
  <label for="email">Email*</label><input id="email" type="email" required>
  <label for="phone">Phone</label><input id="phone" type="tel">`;

for (const modern of [true, false])
  for (const replace of [false, true])
    test(`Greenhouse ${modern ? "modern" : "legacy"} startup fills the live form${replace ? " replaced during Profile loading" : ""}`, async (t) => {
      const h = await adapterPage(t, {
        site: "greenhouse",
        html: modern
          ? `<form id="application-form">${fields}</form>`
          : `<div id="application"><form id="application_form">${fields}</form></div>`,
        url: modern
          ? "https://job-boards.greenhouse.io/embed/job_app?for=fixture&token=123"
          : "https://boards.greenhouse.io/fixture/jobs/123",
      });
      // Cover-letter/error observers are unrelated to the startup operation.
      h.w.jobsWatchXPathPresence = () => {};
      let readProfile, releaseProfile;
      const profileRequested = new Promise((resolve) => {
        readProfile = resolve;
      });
      const profileReply = new Promise((resolve) => {
        releaseProfile = resolve;
      });
      const options = h.w.JobsAutomatic.observe({
        ctx: { isInvalid: false, onInvalidated() {}, addEventListener() {} },
        pageSession: { phase: "idle" },
        getProfile: () => {
          readProfile();
          return profileReply;
        },
        setMessage: (value) => h.phases.push(value),
        autofillSettings: {
          saveApplications: false,
          saveResponses: false,
          autoSubmit: false,
        },
      });
      await h.w.greenhouseRunApplication(options);
      await profileRequested;
      const original = h.doc.querySelector("form");
      if (replace) original.replaceWith(original.cloneNode(true));
      h.doc.getElementById("last_name").value = "Existing";
      releaseProfile(profile);
      for (
        let i = 0;
        i < 150 && !h.notes.some((note) => note.type === "auto_step_finished");
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(h.value("#first_name"), profile.nameData.firstName);
      assert.equal(h.value("#email"), profile.contactData.email);
      assert.equal(h.value("#phone"), profile.contactData.phoneNumber);
      assert.equal(h.value("#last_name"), "Existing");
      assert.equal(h.phases.at(-1), "page-complete");
      assert.equal(
        h.notes.filter((note) => note.type === "auto_step_started").length,
        1,
      );
      if (replace) {
        assert.equal(original.isConnected, false);
        assert.equal(original.querySelector("#first_name").value, "");
      }
    });
