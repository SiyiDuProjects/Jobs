import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsPageSession } from "../../../src/custom/control-content.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import { JobsControlFields } from "../../../src/custom/control-fields.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import { jobsSaveApplicationRecord } from "../shared/runtime-messages.js";
import { jobsMountManualAnswerControls } from "../shared/answer-ui.js";
import {
  jobsWaitForConfirmation,
  jobsFindXPath,
  jobsUploadResume,
  jobsWaitForCssNodes,
} from "../shared/dom-controls.js";
import { jobsFormatFullName } from "../shared/profile-format.js";
// Each ADP step runs as one page pipeline: declared Profile facts and
// disclosures, then the rules (veteran status and the questions step), AI
// for remaining required answers, review and navigation. The guest sign-in
// step is filled only; the attestation step submits.
async function adpRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  accountSettings: accountSettings,
  ctx: context,
}) {
  const step = (selector, fill, navigation = `next`) =>
    jobsWaitForCssNodes(selector).then(async () => {
      const profile = await getProfile();
      await JobsFormPipeline.settled(JobsPageSession?.root() || document.body);
      await JobsAutomatic.advance({
        profile,
        setMessage,
        ...(navigation === `next`
          ? {
              action: autofillSettings.autoClickNextPage ? `next` : `fill`,
              selector: JobsPlatformConfig.structure.adp.next,
            }
          : navigation === `submit`
            ? {
                action: autofillSettings.autoSubmit ? `submit` : `fill`,
                selector: JobsPlatformConfig.structure.adp.submit,
              }
            : { action: `fill` }),
        fill: fill && ((canProceed) => fill(profile, canProceed)),
      });
    });
  step(
    `[name='loginView']`,
    (profile) => adpFillGuestAccount(profile, accountSettings),
    null,
  );
  step(`.personal-step-container`, adpFillPersonalInformation);
  step(
    `#resumeUploadContainer`,
    async ({ resumeData }) =>
      resumeData?.resumeBase64 &&
      jobsUploadResume(resumeData, `#resumeUploadContainer input`),
  );
  jobsWaitForCssNodes(`.questions-main-container`).then(() =>
    jobsMountManualAnswerControls(context, [
      [
        `//div[contains(@class, 'questions-main-container')]//textarea`,
        `../preceding-sibling::div`,
      ],
    ]),
  );
  step(`.questions-main-container`, null);
  step(`.self-review-container.personal-step-container`, null);
  step(`.applicationvsid-main-container`, (profile) =>
    adpFillDisclosures(profile.employmentData),
  );
  step(`.self-attestation-container`, adpFillAttestation, `submit`);
  autofillSettings.saveApplications &&
    jobsWaitForConfirmation("adp").then(() => {
      (setMessage(null), adpRecordApplication());
    });
}
function adpFormatPhoneNumber(phoneNumber, country) {
  return country === `United States of America` && !phoneNumber.startsWith(`1`)
    ? `1${phoneNumber}`
    : phoneNumber;
}
async function adpFillGuestAccount(profile, accountSettings) {
  await JobsFormPipeline.bind([
    {
      name: "first-name",
      find: `#guestFirstName`,
      answer: profile.nameData.firstName,
    },
    {
      name: "last-name",
      find: `#guestLastName`,
      answer: profile.nameData.lastName,
    },
    {
      name: "email",
      find: `#guestEmail`,
      answer: accountSettings?.accountEmail,
    },
    {
      name: "phone",
      find: `#login_view_phone`,
      answer:
        profile.contactData.phoneNumber &&
        adpFormatPhoneNumber(
          profile.contactData.phoneNumber,
          profile.addressData.country,
        ),
    },
  ]);
}
async function adpFillPersonalInformation(profile) {
  const name = profile.nameData,
    address = profile.addressData,
    answers = JobsProfileAnswers;
  const input = (caption) => `//label[${caption}]/../following-sibling::input`,
    menu = (caption) =>
      `//label[${caption}]/../following-sibling::div//div[contains(@class,'input-container')]`;
  const state = `contains(text(),'State') or contains(text(),'Province')`;
  await JobsFormPipeline.bind([
    {
      name: "first-name",
      find: `#personalInfomationFirstName`,
      answer: name.firstName,
    },
    {
      name: "last-name",
      find: `#personalInfomationLastName`,
      answer: name.lastName,
    },
    {
      name: "use-preferred-name",
      find: `#usePreferredName input[type='checkbox']:not([disabled])`,
      checked: name.preferredName ? true : undefined,
    },
    {
      name: "preferred-first-name",
      find: `#preferredName`,
      answer: name.preferredName && name.preferredFirstName,
    },
    {
      name: "preferred-last-name",
      find: `#preferredFamilyName`,
      answer: name.preferredName && name.preferredLastName,
    },
    {
      name: "email",
      find: `#personalInfomationEmail`,
      answer: profile.contactData.email,
    },
    {
      name: "country",
      find: menu(`contains(text(),'Country')`),
      answer: answers.countrySpec(address.country),
    },
    {
      name: "line1",
      find: input(`contains(text(),'Line 1')`),
      answer: address.line1,
    },
    {
      name: "line2",
      find: input(`contains(text(),'Line 2')`),
      answer: address.line2,
    },
    {
      name: "city",
      find: input(`contains(text(),'City')`),
      answer: address.city,
    },
    // The state is a text box or, for countries with regions, a menu.
    { name: "state-text", find: input(state), answer: address.state },
    {
      name: "state",
      find: menu(state),
      answer: answers.regionSpec(address.state, address.country),
    },
    {
      name: "postal-code",
      find: input(
        `contains(text(),'Postal Code') or contains(text(), 'Zip Code')`,
      ),
      answer: address.postalCode,
    },
  ]);
}
// One EEO rule for every ATS; this form's own options decide the wording.
// A declined ethnicity declines race with the page's own checkbox.
async function adpFillDisclosures(employment) {
  const eeo = JobsProfileAnswers.eeoSpec,
    menu = (caption) =>
      `//label[${caption}]/following-sibling::div//div[contains(@class,'input-container')]`;
  const hispanic = eeo(`hispanic`, employment),
    race = () => jobsFindXPath(menu(`contains(text(),'Race')`));
  const [ethnicity] = await JobsFormPipeline.bind([
    {
      name: "gender",
      find: `//label[text[contains(text(),'Gender')]]/following-sibling::div//div[contains(@class,'input-container')]`,
      answer: eeo(`gender`, employment),
    },
    {
      name: "ethnicity",
      find: menu(`contains(text(),'Ethnicity')`),
      answer: hispanic,
    },
  ]).then((results) => results.slice(1));
  await JobsFormPipeline.bind([
    {
      name: "decline-race",
      find: `#enthinicityAndRaceId input[type='checkbox']:not([disabled])`,
      checked: hispanic?.declined && !ethnicity ? true : undefined,
      whenEmpty: [
        menu(`contains(text(),'Ethnicity')`),
        menu(`contains(text(),'Race')`),
      ],
    },
    {
      name: "race",
      find: () =>
        !hispanic?.declined &&
        race() &&
        JobsControlFields.create(document).visible(race())
          ? race()
          : null,
      answer: eeo(`race`, employment),
    },
    {
      name: "disability-check",
      find: `#disabilityStatusCheck input[type='checkbox']:not([disabled])`,
      topic: "consent",
    },
    {
      name: "disability",
      find: `#disabilityStatusIdYes, #disabilityStatusIdNo, #disabilityStatusIdDecline`,
      answer: eeo(`disability`, employment),
    },
  ]);
}
async function adpFillAttestation(profile) {
  await JobsDOMWait.until(
    () =>
      document.querySelector(
        `#self_att_agree_chk input[type='checkbox']:not([disabled])`,
      ),
    { timeout: 5000 },
  );
  await JobsFormPipeline.bind([
    {
      name: "agree",
      find: `#self_att_agree_chk input[type='checkbox']:not([disabled])`,
      topic: "consent",
    },
    {
      name: "signature",
      find: `#electronicSignature`,
      answer: jobsFormatFullName(profile.nameData),
    },
  ]);
}
async function adpRecordApplication() {
  let e = new URL(window.location.href),
    t = new URLSearchParams(e.search),
    n = t.get(`cid`),
    r = t.get(`jobId`),
    i = `https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html`,
    a = `${i}?cid=${n}`;
  await jobsSaveApplicationRecord({
    jobsSyncProof: "ats_confirmation",
    jobTitle: ``,
    jobLink: `${i}?cid=${n}&jobId=${r}`,
    companyLink: a,
  });
}

export {
  adpRunApplication,
  adpFormatPhoneNumber,
  adpFillGuestAccount,
  adpFillPersonalInformation,
  adpFillDisclosures,
  adpFillAttestation,
  adpRecordApplication,
};
