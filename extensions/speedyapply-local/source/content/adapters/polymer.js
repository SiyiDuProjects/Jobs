import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import {
  jobsReportJobTitle,
  jobsSaveApplicationRecord,
} from "../shared/runtime-messages.js";
import { jobsMountManualAnswerControls } from "../shared/answer-ui.js";
import {
  jobsWaitForConfirmation,
  jobsUploadResume,
  jobsWaitForCssNodes,
  jobsWaitForXPathNodes,
} from "../shared/dom-controls.js";
import { jobsFormatFullName } from "../shared/profile-format.js";
// The Polymer form runs as one page pipeline: declared Profile facts, then
// the rules, AI for remaining required answers, review and navigation.
async function polymerRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  ctx: context,
}) {
  jobsWaitForCssNodes(JobsPlatformConfig.structure.polymer.root).then(
    async ([form]) => {
      const profile = await getProfile();
      await jobsMountManualAnswerControls(context, [
        [`//div[@id='apply']//form//textarea`, `preceding-sibling::div`],
      ]);
      await polymerTrackApplication(
        setMessage,
        Boolean(autofillSettings.saveApplications),
      );
      await JobsAutomatic.advance({
        root: form,
        profile,
        setMessage,
        action: autofillSettings.autoSubmit ? `submit` : `fill`,
        selector: JobsPlatformConfig.structure.polymer.submit,
        fill: () => polymerFillApplication(profile),
      });
    },
  );
}
async function polymerFillApplication(profile) {
  const address = profile.addressData;
  await JobsFormPipeline.bind([
    {
      name: "name",
      find: `#inputName`,
      answer: jobsFormatFullName(profile.nameData),
    },
    {
      name: "email",
      find: `#inputEmailaddress`,
      answer: profile.contactData.email,
    },
    {
      name: "phone",
      find: `#inputPhonenumber`,
      answer: profile.contactData.phoneNumber,
    },
    {
      name: "location",
      find: `#inputLocation`,
      answer: `${address.city}${address.state ? `, ${address.state}` : ``}, ${address.country}`,
    },
    {
      name: "linkedin",
      find: `#inputLinkedInprofile`,
      answer: profile.websiteData.linkedin,
    },
    {
      name: "github",
      find: `#inputGitHubprofile`,
      answer: profile.websiteData.github,
    },
    {
      name: "twitter",
      find: `#inputTwitterprofile`,
      answer: profile.websiteData.twitter,
    },
  ]);
  profile.resumeData?.resumeBase64 &&
    jobsUploadResume(profile.resumeData, `#file`);
}
async function polymerTrackApplication(setMessage, record = true) {
  let t = document.querySelector(`.title`),
    n = /** @type {HTMLAnchorElement} */ (
      document.querySelector(`.header__website`)
    ),
    r = ``,
    i = ``;
  if ((t && t.textContent && (r = t.textContent), n && n.href)) {
    let e = new URL(n.href);
    i = e.origin + e.pathname;
  }
  let a = window.location.href,
    o = a.match(/(https:\/\/jobs\.polymer\.co\/[^/]+\/\d+)/),
    s = o ? o[1] : ``;
  if (!i) {
    let e = a.match(/(https:\/\/jobs\.polymer\.co\/[^/]+)/);
    i = e ? e[1] : ``;
  }
  void jobsReportJobTitle(r);
  if (!record) return;
  jobsWaitForConfirmation("polymer").then(() => {
    (jobsSaveApplicationRecord({
      jobsSyncProof: "ats_confirmation",
      jobTitle: r,
      jobLink: s,
      companyLink: i,
    }),
      setMessage(null));
  });
}
export {
  polymerRunApplication,
  polymerFillApplication,
  polymerTrackApplication,
};
