import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import {
  jobsReportJobTitle,
  jobsSaveApplicationRecord,
} from "../shared/runtime-messages.js";
import { jobsMountManualAnswerControls } from "../shared/answer-ui.js";
import {
  jobsWaitForConfirmation,
  jobsFindXPath,
  jobsUploadResume,
  jobsWaitForCssNodes,
  jobsWaitForXPathNodes,
} from "../shared/dom-controls.js";
// The Comeet form runs as one page pipeline: declared Profile facts and
// disclosures, then the rules (veteran status and the other questions), AI
// for remaining required answers, review and navigation.
async function comeetRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  ctx: context,
}) {
  jobsWaitForCssNodes(JobsPlatformConfig.structure.comeet.root).then(
    async ([form]) => {
      const profile = await getProfile();
      await jobsMountManualAnswerControls(context, [
        [`//textarea[@id='inputNote']`, `../preceding-sibling::label`],
      ]);
      await comeetTrackApplication(
        setMessage,
        Boolean(autofillSettings.saveApplications),
      );
      await JobsAutomatic.advance({
        root: form,
        profile,
        setMessage,
        action: autofillSettings.autoSubmit ? `submit` : `fill`,
        target:
          jobsFindXPath(JobsPlatformConfig.structure.comeet.submitXPath) ||
          void 0,
        fill: () => comeetFillApplication(profile),
      });
    },
  );
}
async function comeetFillApplication(profile) {
  await JobsFormPipeline.bind([
    {
      name: "first-name",
      find: `#inputFirstName`,
      answer: profile.nameData.firstName,
    },
    {
      name: "last-name",
      find: `#inputLastName`,
      answer: profile.nameData.lastName,
    },
    { name: "email", find: `#inputEmail`, answer: profile.contactData.email },
    {
      name: "phone",
      find: `#inputTel`,
      answer: profile.contactData.phoneNumber,
    },
    {
      name: "website",
      find: `#inputLink`,
      answer: profile.websiteData.personal,
    },
    {
      name: "linkedin",
      find: `#linkedin`,
      answer: profile.websiteData.linkedin,
    },
  ]);
  profile.resumeData?.resumeBase64 &&
    jobsUploadResume(profile.resumeData, `#cv`);
  await comeetFillDisclosures(profile.employmentData);
  await JobsFormPipeline.bind([
    { name: "gdpr-consent", find: `#gdprConsent`, topic: "consent" },
  ]);
}
// One EEO rule for every ATS; this form's own options decide the wording.
async function comeetFillDisclosures(employment) {
  const list = (caption) =>
      `//legend[contains(text(), '${caption}')]/../following-sibling::div//ul`,
    eeo = JobsProfileAnswers.eeoSpec;
  await JobsFormPipeline.bind([
    { name: "gender", find: list(`Gender`), answer: eeo(`gender`, employment) },
    { name: "race", find: list(`Ethnicity`), answer: eeo(`race`, employment) },
    {
      name: "disability",
      find: list(`Disability`),
      answer: eeo(`disability`, employment),
    },
  ]);
}
async function comeetTrackApplication(setMessage, record = true) {
  let t =
      [...document.querySelectorAll(`script`)].find((e) =>
        /POSITION_DATA/.test(e.textContent || ``),
      )?.textContent ?? ``,
    n = t.indexOf(`"position_uid"`),
    r = [],
    i = !1,
    a = !1,
    o = null;
  for (let e = 0; n >= 0 && e < t.length && !o; e++) {
    let s = t[e];
    if (i) a ? (a = !1) : s === `\\` ? (a = !0) : s === `"` && (i = !1);
    else if (s === `"`) i = !0;
    else if (s === `{`) r.push(e);
    else if (s === `}`) {
      let i = r.pop();
      i !== void 0 && i <= n && e >= n && (o = t.slice(i, e + 1));
    }
  }
  let s = (e) => {
      if (!o) return null;
      let t = RegExp(`"${e}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(o);
      return t ? JSON.parse(`"` + t[1] + `"`) : null;
    },
    c = s(`name`),
    l = s(`company_name`),
    u = s(`careers_page_url`);
  if (!c || !u) return;
  let d = u,
    f = d.split(`/`).slice(0, -2).join(`/`);
  void jobsReportJobTitle(c);
  if (!record) return;
  jobsWaitForConfirmation("comeet").then(() => {
    (jobsSaveApplicationRecord({
      jobsSyncProof: "ats_confirmation",
      jobTitle: c,
      jobLink: d,
      companyName: l || void 0,
      companyLink: f,
    }),
      setMessage(null));
  });
}

export {
  comeetRunApplication,
  comeetFillApplication,
  comeetFillDisclosures,
  comeetTrackApplication,
};
