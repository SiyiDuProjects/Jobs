import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import {
  jobsReportJobTitle,
  jobsSaveApplicationRecord,
} from "../shared/runtime-messages.js";
import { jobsMountManualAnswerControls } from "../shared/answer-ui.js";
import {
  jobsWaitForConfirmation,
  jobsFindXPath,
  jobsUploadResume,
  jobsWaitForXPathNodes,
} from "../shared/dom-controls.js";
// The Dover form runs as one page pipeline: declared Profile facts, then the
// rules, AI for remaining required answers, review and navigation.
async function doverRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  ctx: context,
}) {
  jobsWaitForXPathNodes(JobsPlatformConfig.structure.dover.rootXPath).then(
    async ([form]) => {
      const profile = await getProfile();
      await jobsMountManualAnswerControls(context, [
        [
          `//div[contains(text(),'Apply')]/following-sibling::form//textarea[not(@aria-hidden='true')]`,
          `ancestor::*[contains(@class, 'MuiBox-root')][1]`,
        ],
      ]);
      await doverTrackApplication(
        setMessage,
        Boolean(autofillSettings.saveApplications),
      );
      await JobsAutomatic.advance({
        root: form,
        profile,
        setMessage,
        action: autofillSettings.autoSubmit ? `submit` : `fill`,
        selector: JobsPlatformConfig.structure.dover.submit,
        fill: () => doverFillApplication(profile),
      });
    },
  );
}
async function doverFillApplication(profile) {
  await JobsFormPipeline.bind([
    {
      name: "first-name",
      find: `[name='firstName']`,
      answer: profile.nameData.firstName,
    },
    {
      name: "last-name",
      find: `[name='lastName']`,
      answer: profile.nameData.lastName,
    },
    {
      name: "linkedin",
      find: `[name='linkedinUrl']`,
      answer: profile.websiteData.linkedin,
    },
    {
      name: "email",
      find: `[name='email']`,
      answer: profile.contactData.email,
    },
    {
      name: "phone",
      find: `[name='phoneNumber']`,
      answer: profile.contactData.phoneNumber,
    },
  ]);
  profile.resumeData?.resumeBase64 &&
    jobsUploadResume(
      profile.resumeData,
      `//div[contains(text(),'Resume')]/following-sibling::div//input[@type='file']`,
      !0,
    );
}
async function doverTrackApplication(setMessage, record = true) {
  const titleUrl = location.href;
  let t = jobsFindXPath(
      `//a[img]/../following-sibling::div[1]/div | //img/../following-sibling::div[1]/div`,
    ),
    n = /** @type {HTMLAnchorElement} */ (jobsFindXPath(`//a[img]`)),
    r = /** @type {HTMLAnchorElement} */ (
      jobsFindXPath(`//a[@href='https://dover.com']/following::a[1]`)
    );
  // The receipt names the job in its title once the page has rendered.
  if (record)
    await JobsDOMWait.until(() => document.title.includes(` at `), {
      timeout: 2000,
    });
  let i = document.title.split(` at `).pop()?.trim(),
    a = ``,
    o = ``;
  (t && t.textContent && (a = t.textContent),
    n && n.href
      ? (o = n.href)
      : r &&
        r.href &&
        (o = r.href.endsWith(`/audit`) ? r.href.slice(0, -6) : r.href));
  let s = window.location.href.match(
      /(https:\/\/app\.dover\.(io|com)\/apply\/[^/]+\/[a-f0-9-]+)/,
    ),
    c = s ? s[1] : ``;
  void jobsReportJobTitle(a, titleUrl);
  if (!record) return;
  jobsWaitForConfirmation("dover").then(() => {
    (jobsSaveApplicationRecord({
      jobsSyncProof: "ats_confirmation",
      jobTitle: a,
      jobLink: c,
      companyLink: o,
      companyName: i,
    }),
      setMessage(null));
  });
}
export { doverRunApplication, doverFillApplication, doverTrackApplication };
