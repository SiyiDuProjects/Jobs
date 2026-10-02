import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import { JobsControlFields } from "../../../src/custom/control-fields.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import { JobsPageActions } from "../../../src/custom/page-actions.js";
import { format as $j, parse as dN } from "date-fns";
import {
  jobsReportJobTitle,
  jobsSaveApplicationRecord,
} from "../shared/runtime-messages.js";
import { jobsMountManualAnswerControls } from "../shared/answer-ui.js";
import {
  jobsWaitForConfirmation,
  jobsClick,
  jobsFillAccount,
  jobsFindXPath,
  jobsUploadResume,
  jobsWaitAndClick,
  jobsWaitForXPathNodes,
} from "../shared/dom-controls.js";
import { jobsProfileWebsiteEntries } from "../shared/profile-format.js";
function ultiproMonthYearParts(monthValue) {
  let t = dN(monthValue, `yyyy-MM`, new Date());
  return { month: $j(t, `MMM`), year: $j(t, `yyyy`) };
}
// The UltiPro application runs as one page pipeline: declared Profile facts,
// history, skills, links and disclosures, then the rules (referral, veteran
// status and the other questions), AI for remaining required answers, review
// and navigation. Sign-in and registration take the saved account.
async function ultiproRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  accountSettings: accountSettings,
  ctx: context,
}) {
  jobsWaitForXPathNodes(`//form[@id='register_form']`).then(async () =>
    ultiproFillRegistration(accountSettings, await getProfile()),
  );
  jobsWaitForXPathNodes(`//form[contains(@class, 'auth-form')]`).then(() =>
    ultiproFillLogin(accountSettings),
  );
  jobsWaitForXPathNodes(JobsPlatformConfig.structure.ultipro.rootXPath).then(
    async ([root]) => {
      const profile = await getProfile();
      await jobsMountManualAnswerControls(context, [
        [`//textarea`, `preceding-sibling::label`],
      ]);
      // The submit button lives in its own shadow root.
      const submit = document
        .querySelector(JobsPlatformConfig.structure.ultipro.submitHost)
        ?.shadowRoot?.querySelector(`button`);
      const navigated = await JobsAutomatic.advance({
        root,
        profile,
        setMessage,
        action: autofillSettings.autoSubmit && submit ? `submit` : `fill`,
        target: submit || void 0,
        fill: (current) => ultiproFillApplication(profile, current),
      });
      // Submitting asks whether to continue without further attachments.
      if (navigated && autofillSettings.autoSubmit)
        jobsWaitAndClick(`button[data-automation='attachments-modal-yes']`);
    },
  );
  jobsWaitForConfirmation("ultipro").then(() =>
    ultiproRecordApplication(Boolean(autofillSettings.saveApplications)),
  );
}
async function ultiproRecordApplication(record = true) {
  let e = document.querySelector(`h1`),
    t = /** @type {HTMLAnchorElement} */ (
      document.querySelector(`a.navbar-brand`)
    ),
    n = ``,
    r = ``;
  if (
    (e &&
      e.textContent?.includes(`You applied for`) &&
      (n = e.textContent.replace(/^You applied for /, ``)),
    t && t.href && (r = t.href),
    !r)
  ) {
    let e = window.location.href.match(
      /^https:\/\/[^/]+\.ultipro\.(com|ca)\/[^/]+\/JobBoard\/[^/]+/,
    );
    r = e ? e[0] : ``;
  }
  void jobsReportJobTitle(n);
  if (!record) return;
  await jobsSaveApplicationRecord({
    jobsSyncProof: "ats_confirmation",
    jobTitle: n,
    jobLink: ``,
    companyLink: r,
  });
}
async function ultiproFillRegistration(accountSettings, profile) {
  await jobsFillAccount([
    { find: `#FirstName`, value: profile.nameData.firstName },
    { find: `#FamilyName`, value: profile.nameData.lastName },
    { find: `#Email`, value: accountSettings.accountEmail },
    { find: `#Password`, value: accountSettings.accountPassword },
    { find: `#ConfirmPassword`, value: accountSettings.accountPassword },
    { find: `#PhoneNumber`, value: profile.contactData.phoneNumber },
  ]);
}
async function ultiproFillLogin(accountSettings) {
  await jobsFillAccount([
    {
      find: `//*[contains(@class, 'username')]//input`,
      value: accountSettings.accountEmail,
    },
    {
      find: `//*[contains(@class, 'passphrase')]//input`,
      value: accountSettings.accountPassword,
    },
  ]);
}
async function ultiproFillApplication(profile, canProceed = () => true) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  const address = profile.addressData,
    answers = JobsProfileAnswers;
  await section(`contact`, () =>
    JobsFormPipeline.bind([
      // The state list is loaded for the chosen country.
      {
        name: "country",
        find: `#Country`,
        answer: answers.countrySpec(address.country),
        after: () =>
          JobsFormPipeline.settled(
            document.querySelector(`#OpportunityApply`) || document.body,
            { canProceed },
          ),
      },
      { name: "address1", find: `#AddressLine1`, answer: address.line1 },
      { name: "address2", find: `#AddressLine2`, answer: address.line2 },
      { name: "city", find: `#City`, answer: address.city },
      {
        name: "state",
        find: `#State`,
        answer: answers.regionSpec(address.state, address.country),
      },
      { name: "postal-code", find: `#PostalCode`, answer: address.postalCode },
      {
        name: "phone",
        find: `#Phone`,
        answer: profile.contactData.phoneNumber,
      },
    ]),
  );
  await section(`employment`, () =>
    ultiproAddEntries(
      `Work Experience`,
      `Add Experience`,
      profile.jobData,
      (entry, item) => [
        {
          name: "title",
          find: `${item}//input[@data-automation='job-title-textbox']`,
          answer: entry.jobTitle,
        },
        {
          name: "company",
          find: `${item}//input[@data-automation='company-textbox']`,
          answer: entry.company,
        },
        {
          name: "location",
          find: `${item}//input[@data-automation='location-textbox']`,
          answer: entry.location,
        },
        ...ultiproMonthBindings(item, `from`, entry.startDate),
        ...(entry.endDate && !entry.currentlyWorkHere
          ? ultiproMonthBindings(item, `to`, entry.endDate)
          : []),
        {
          name: "description",
          find: `${item}//textarea[@data-automation='description-textarea']`,
          answer: entry.description,
        },
      ],
      canProceed,
    ),
  );
  await section(`education`, () =>
    ultiproAddEntries(
      `Education`,
      `Add Education`,
      profile.educationData,
      (entry, item) => [
        {
          name: "school",
          find: `${item}//input[@data-automation='school-textbox']`,
          answer: entry.school,
        },
        {
          name: "degree",
          find: `${item}//input[@data-automation='degree-textbox']`,
          answer: entry.degree,
        },
        {
          name: "major",
          find: `${item}//select[@data-automation='major-dropdown']`,
          answer: answers.literalSpec("known-answer", entry.fieldOfStudy),
        },
        ...ultiproMonthBindings(item, `from`, entry.startDate),
        ...(entry.endDate && !entry.currentlyAttending
          ? ultiproMonthBindings(item, `to`, entry.endDate)
          : []),
      ],
      canProceed,
    ),
  );
  await section(`skills`, () => ultiproFillSkills(profile.skillsData));
  await section(`links`, () => ultiproFillWebsites(profile.websiteData));
  await section(
    `resume`,
    () =>
      profile.resumeData?.resumeBase64 &&
      jobsUploadResume(
        profile.resumeData,
        `//h2[contains(text(),'Documents')]/../../following-sibling::div//input[@data-automation='upload-file-input']`,
        !0,
      ),
  );
  await section(`source`, () => ultiproFillApplicationSource(profile));
  await section(`disclosures`, () =>
    ultiproFillDisclosures(profile.employmentData),
  );
}
async function ultiproFillApplicationSource(profile) {
  await JobsFormPipeline.bind([
    {
      name: "source",
      find: `//select[@data-automation='applicant-source-dropdown']`,
      answer: JobsProfileAnswers.recruitingSourceSpec(profile),
    },
  ]);
}
// A month field is a month list and a year box.
function ultiproMonthBindings(item, edge, date) {
  return date
    ? [
        {
          name: `${edge}-month`,
          find: `${item}//select[@data-automation='${edge}-month-dropdown']`,
          answer: JobsProfileAnswers.datePartSpec(date, "month"),
        },
        {
          name: `${edge}-year`,
          find: `${item}//input[@data-automation='${edge}-year-textbox']`,
          answer: ultiproMonthYearParts(date).year,
        },
      ]
    : [];
}
// One EEO rule for every ATS; this form's own options decide the wording.
// A declined answer the list cannot take uses the question's decline box.
async function ultiproFillDisclosures(employment) {
  const eeo = JobsProfileAnswers.eeoSpec,
    select = (name) => `//select[@data-automation='${name}']`;
  const withDecline = async (name, topic, decline) => {
    const spec = eeo(topic, employment),
      [selected] = await JobsFormPipeline.bind([
        { name: topic, find: select(name), answer: spec },
      ]);
    if (!selected && spec?.declined)
      await JobsFormPipeline.bind([
        {
          name: `${topic}-decline`,
          find: `//input[@data-automation='${decline}']`,
          checked: true,
          whenEmpty: select(name),
        },
      ]);
  };
  await withDecline(
    `country-questions-gender`,
    `gender`,
    `gender-decline-checkbox`,
  );
  await withDecline(
    `country-questions-ethnic-origin`,
    `hispanic`,
    `ethnic-origin-decline-checkbox`,
  );
  await JobsFormPipeline.bind([
    {
      name: "race",
      find: () =>
        ((race) =>
          race && JobsControlFields.create(document).visible(race)
            ? race
            : null)(jobsFindXPath(select(`country-questions-race`))),
      answer: eeo(`race`, employment),
    },
  ]);
  // An ordinary veteran answer is the rules'; a declined one uses the decline box.
  if (eeo(`veteran`, employment)?.declined)
    await withDecline(
      `country-questions-us-federal-contractor`,
      `veteran`,
      `us-federal-contractor-question-decline-checkbox`,
    );
  await JobsFormPipeline.bind([
    {
      name: "disability",
      find: `//input[@data-automation='disability-status-yes' or @data-automation='disability-status-no' or @data-automation='disability-status-decline']`,
      answer: eeo(`disability`, employment),
    },
  ]);
}
// Structure: the Links editor is opened when it is empty; each link row is
// added at the top with the Add Link button.
async function ultiproFillWebsites(websites) {
  const links = jobsProfileWebsiteEntries(websites),
    header = `//h2[contains(text(),'Links')]/following-sibling::span/following-sibling::span/following-sibling::span`;
  const region = `//h2[contains(text(),'Links')]/../../following-sibling::div`;
  if (
    !links.length ||
    jobsFindXPath(`${header}//button[@aria-label='Edit Links']`) === null ||
    jobsFindXPath(
      `${region}//ul[contains(@class, 'listtype') and count(li) > 0]`,
    ) !== null
  )
    return;
  jobsClick(`${header}//button[@aria-label='Edit Links']`, !0);
  if (
    !(await JobsDOMWait.until(
      () =>
        jobsFindXPath(`(${region}//input[@data-automation='url-textbox'])[1]`),
      { timeout: 5000 },
    ))
  )
    return;
  for (let index = 0; index < links.length; index++) {
    const row = (input) =>
      jobsFindXPath(`(${region}//input[@data-automation='${input}'])[1]`);
    await JobsFormPipeline.bind([
      {
        name: `link-title-${index}`,
        find: () => row(`title-textbox`),
        answer: links[index].name,
      },
      {
        name: `link-url-${index}`,
        find: () => row(`url-textbox`),
        answer: links[index].url,
      },
    ]);
    if (index < links.length - 1) {
      const previous = row(`url-textbox`);
      jobsClick(`${header}//button[@aria-label='Add Link']`, !0);
      if (
        !(await JobsDOMWait.until(() => row(`url-textbox`) !== previous, {
          timeout: 5000,
        }))
      )
        break;
    }
  }
  jobsClick(`${region}//button[@data-automation='save-button']`, !0);
}
// Skills are free-text tags added in the Skills editor.
async function ultiproFillSkills(skills) {
  const region = `//h2[contains(text(),'Skills')]/../../following-sibling::div`;
  const edit = `//h2[contains(text(),'Skills')]/following-sibling::span/following-sibling::span/following-sibling::span//button[@aria-label='Edit Skills']`;
  if (
    !skills?.length ||
    !jobsFindXPath(edit) ||
    jobsFindXPath(
      `${region}//ul[contains(@class, 'listtype') and count(li) > 0]`,
    )
  )
    return;
  jobsClick(edit, !0);
  const editor = await JobsDOMWait.until(
    () => jobsFindXPath(`${region}[@aria-expanded='true']`),
    { timeout: 5000 },
  );
  if (!editor) return;
  await JobsFormPipeline.bind([
    {
      name: "skills",
      find: () => editor,
      answers: skills.map(JobsProfileAnswers.skillSpec).filter(Boolean),
    },
  ]);
  const save = editor.querySelector(`[data-automation="save-button"]`);
  if (save) JobsPageActions.click(save);
}
// Structure: each Profile entry is added at the top of its section and
// edited in its dialog, which closes when saved.
async function ultiproAddEntries(
  title,
  button,
  entries,
  bindings,
  canProceed = () => true,
) {
  const add = `//h2[contains(text(),'${title}')]/following-sibling::span/following-sibling::span/following-sibling::span//button[@aria-label='${button}']`;
  const list = `//h2[contains(text(),'${title}')]/../../following-sibling::div//ul[contains(@class, 'listtype')]`;
  if (
    jobsFindXPath(add) === null ||
    jobsFindXPath(`${list}[count(li) > 0]`) !== null
  )
    return;
  for (
    let index = 0;
    index < entries.length && JobsPageActions.live(canProceed);
    index++
  ) {
    jobsClick(add, !0);
    if (
      !(await JobsDOMWait.until(
        () => jobsFindXPath(`${list}[count(li)=${index + 1}]`),
        { timeout: 5000 },
      ))
    )
      break;
    const item = `${list}//li[1]`;
    await JobsFormPipeline.bind(bindings(entries[index], item));
    jobsClick(`${item}//button[@data-automation='save-button']`, !0);
    await JobsDOMWait.until(
      () =>
        jobsFindXPath(
          `${item}//div[contains(@class, 'dialogBox') and not(contains(@class, 'in'))]`,
        ),
      { timeout: 5000 },
    );
  }
}

export {
  ultiproMonthYearParts,
  ultiproRunApplication,
  ultiproRecordApplication,
  ultiproFillRegistration,
  ultiproFillLogin,
  ultiproFillApplication,
  ultiproFillApplicationSource,
  ultiproMonthBindings,
  ultiproFillDisclosures,
  ultiproFillWebsites,
  ultiproFillSkills,
  ultiproAddEntries,
};
