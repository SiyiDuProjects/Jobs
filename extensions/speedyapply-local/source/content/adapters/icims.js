import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsIcimsControls } from "../../../src/custom/icims-controls.js";
import { JobsPageActions } from "../../../src/custom/page-actions.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import { JobsControlFields } from "../../../src/custom/control-fields.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
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
  jobsWaitForXPathNodes,
} from "../shared/dom-controls.js";
function icimsFormatPhoneNumber(phoneNumber) {
  return phoneNumber.replace(/(\d{3})(\d{3})(\d{3})/, `$1-$2-$3`);
}
// An iCIMS list field is named by its container; the registered list
// control inside it is the field.
function icimsList(scope, id) {
  return () =>
    jobsFindXPath(`${scope}//div[contains(@id,'${id}_icimsDropdown_ctnr')]`)
      ?.parentElement || null;
}
// A date is a month list, a day list and a year box.
function icimsDateBindings(name, date, field) {
  const answers = JobsProfileAnswers;
  return date
    ? [
        {
          name: `${name}-month`,
          find: field(`Month`),
          answer: answers.datePartSpec(date, "month"),
        },
        {
          name: `${name}-day`,
          find: field(`Day`),
          answer: answers.datePartSpec(date, "day"),
        },
        {
          name: `${name}-year`,
          find: field(`Year`),
          answer: answers.datePartSpec(date, "year")?.answer,
        },
      ]
    : [];
}
async function icimsFillCandidateProfile(profile, canProceed = () => true) {
  const upload = await icimsPrepareResume(profile.resumeData, canProceed);
  if (upload?.hold || !JobsPageActions.live(canProceed)) return upload;
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  await section(`contact`, () => icimsFillContact(profile));
  await section(`address`, () => icimsFillAddress(profile.addressData));
  await section(`education`, () =>
    icimsFillEducationHistory(profile.educationData, canProceed),
  );
  await section(`employment`, () =>
    icimsFillEmploymentHistory(profile.jobData, canProceed),
  );
}
// A local selection stays in the form until Submit Profile; its hidden
// FileName can remain empty. Other tenants retain a previously saved file or
// replace the document after parsing. All three paths belong to this run.
async function icimsPrepareResume(resume, canProceed) {
  const prefix = "PortalProfileFields.Resume",
    get = (suffix) => document.getElementById(prefix + suffix),
    input = /** @type {HTMLInputElement|null} */ (get("_File")),
    reader = JobsControlFields.create(document),
    shown = (node) => !!node && reader.visible(node),
    loading = () => shown(get("_Loading"));
  if (!input && !get("_Content") && !get("_FileName")) return null;
  const ready = () => {
    const file = /** @type {HTMLInputElement|null} */ (get("_File")),
      saved = /** @type {HTMLInputElement|null} */ (get("_FileName")),
      label = get("_FileNameLabel")?.textContent?.trim() || "";
    if (
      loading() ||
      !shown(get("_CurrentFile")) ||
      !label ||
      file?.getAttribute("aria-invalid") === "true"
    )
      return false;
    // A displayed name alone is not a retained local file. Require the
    // selected File to agree with the widget, or a saved-file marker.
    return file?.files?.length
      ? label.split(/[\\/]/).at(-1) === file.files[0].name
      : !!saved?.value?.trim();
  };
  if (!JobsPageActions.live(canProceed) || ready()) return null;
  // Preserve an existing selection, including an upload still being processed.
  if (!input?.files?.length && !loading()) {
    if (!input || !resume?.resumeBase64)
      return { hold: "resume_upload_unconfirmed" };
    jobsUploadResume(resume, `input[id="${prefix}_File"][type="file"]`);
  }
  const result = await JobsDOMWait.until(
    () => (!JobsPageActions.live(canProceed) ? { cancelled: true } : ready()),
    { timeout: 30000, interval: 250 },
  );
  return result ? null : { hold: "resume_upload_unconfirmed" };
}
async function icimsFillEducationHistory(
  educationEntries,
  canProceed = () => true,
) {
  return icimsAddEntries(
    `contains(text(), 'Education') or contains(text(), 'School')`,
    educationEntries,
    (entry, group) => {
      const answers = JobsProfileAnswers,
        date = (id, part) =>
          `${group}//select[contains(@id,'CandProfileFields.${id}_${part === "Day" ? "Date" : part}')]`;
      const degreeTrigger = () => {
        const list = jobsFindXPath(
          `${group}//div[contains(@id,'CandProfileFields.Degree_icimsDropdown_ctnr')]//ul`,
        );
        if (!(list instanceof Element)) return null;
        return (
          [
            ...(list
              .closest(".dropdown-container")
              ?.parentElement?.querySelectorAll('a[role="combobox"]') || []),
          ].find((node) => JobsIcimsControls.isControl(node)) || null
        );
      };
      const schoolText = `${group}//label[span[text() = 'School']]/../following-sibling::div/input`;
      return [
        { name: "school", find: schoolText, answer: entry.school },
        {
          name: "school-list",
          find: () =>
            !jobsFindXPath(schoolText) &&
            icimsList(group, `CandProfileFields.School`)(),
          answer: answers.schoolSpec(entry.school),
        },
        // Degree selection cannot short-circuit the later education fields.
        {
          name: "degree",
          find: degreeTrigger,
          answer: answers.degreeSpec(entry.degree),
        },
        {
          name: "graduated",
          find: `${group}//select[contains(@id,'CandProfileFields.IsGraduated')]`,
          answer: answers.literalSpec(
            "graduated",
            answers.resolve("Have you graduated?", { educationData: [entry] })
              ?.answer,
          ),
        },
        {
          name: "major",
          find: icimsList(group, `CandProfileFields.Major`),
          answer: answers.literalSpec("known-answer", entry.fieldOfStudy),
        },
        {
          name: "gpa",
          find: `${group}//input[contains(@id, 'CandProfileFields.GPA')]`,
          answer: entry.gpa,
        },
        ...icimsDateBindings(`start`, entry.startDate, (part) =>
          part === `Year`
            ? `${group}//input[contains(@id,'CandProfileFields.EducationStartDate_Year')]`
            : date(`EducationStartDate`, part),
        ),
        ...icimsDateBindings(`graduation`, entry.endDate, (part) =>
          part === `Year`
            ? `${group}//input[contains(@id,'CandProfileFields.GraduationDate_Year')]`
            : date(`GraduationDate`, part),
        ),
      ];
    },
    canProceed,
  );
}
async function icimsFillEmploymentHistory(
  employmentEntries,
  canProceed = () => true,
) {
  return icimsAddEntries(
    `contains(text(), 'Work') or contains(text(), 'Professional')`,
    employmentEntries,
    (entry, group) => {
      const input = (caption) =>
        `${group}//label[span[${caption}]]/../following-sibling::div/input`;
      const date = (edge) => (part) =>
        `${group}//label[span[text() = '${edge}']]/../following-sibling::div//label[text()='${part}']/following-sibling::${part === `Year` ? `input` : `select`}`;
      return [
        {
          name: "employer",
          find: input(`text() = 'Employer'`),
          answer: entry.company,
        },
        {
          name: "title",
          find: input(`text() = 'Title'`),
          answer: entry.jobTitle,
        },
        {
          name: "location",
          find: input(`text() = 'Location' or text() = 'City'`),
          answer: entry.location,
        },
        ...icimsDateBindings(`start`, entry.startDate, date(`Start Date`)),
        ...icimsDateBindings(
          `end`,
          entry.currentlyWorkHere ? null : entry.endDate,
          date(`End Date`),
        ),
        {
          name: "description",
          find: `${group}//label[span[text() = 'Description']]/../following-sibling::div/textarea`,
          answer: entry.description,
        },
      ];
    },
    canProceed,
  );
}
async function icimsFillContact(profile) {
  const name = profile.nameData;
  await JobsFormPipeline.bind([
    {
      name: "first-name",
      find: `#PersonProfileFields\\.FirstName`,
      answer: name.firstName,
    },
    {
      name: "preferred-name",
      find: `//label[contains(text(),'Preferred') and contains(text(), 'Name')]/../following-sibling::div/input`,
      answer: name.preferredFirstName,
    },
    {
      name: "last-name",
      find: `#PersonProfileFields\\.LastName`,
      answer: name.lastName,
    },
    {
      name: "email",
      find: `#PersonProfileFields\\.Email`,
      answer: profile.contactData.email,
    },
    {
      name: "phone-type",
      find: `//select[contains(@id, 'PersonProfileFields.PhoneType')]`,
      answer: JobsProfileAnswers.phoneTypeSpec(
        profile.contactData.phoneDeviceType,
      ),
    },
    {
      name: "phone",
      find: `//input[contains(@id, 'PersonProfileFields.PhoneNumber')]`,
      answer:
        profile.contactData.phoneNumber &&
        icimsFormatPhoneNumber(profile.contactData.phoneNumber),
    },
  ]);
}
async function icimsFillAddress(address) {
  const answers = JobsProfileAnswers,
    field = (id) => `//input[contains(@id, 'PersonProfileFields.${id}')]`;
  await JobsFormPipeline.bind([
    {
      name: "address-type",
      find: `//select[contains(@id, 'PersonProfileFields.AddressType')]`,
      answer: answers.literalSpec("address_type", address.addressType),
    },
    { name: "street1", find: field(`AddressStreet1`), answer: address.line1 },
    { name: "street2", find: field(`AddressStreet2`), answer: address.line2 },
    { name: "city", find: field(`AddressCity`), answer: address.city },
    { name: "zip", find: field(`AddressZip`), answer: address.postalCode },
    // The state list is loaded for the chosen country.
    {
      name: "country",
      find: icimsList(``, `PersonProfileFields.AddressCountry`),
      answer: answers.countrySpec(address.country),
    },
    {
      name: "state",
      find: icimsList(``, `PersonProfileFields.AddressState`),
      answer: answers.regionSpec(address.state, address.country),
    },
  ]);
}
// Structure: numbered history groups; each next one is added from the
// previous group's Add More link.
async function icimsAddEntries(
  title,
  entries,
  bindings,
  canProceed = () => true,
) {
  if (!jobsFindXPath(`//h2[${title}]|//legend/span[${title}]`)) return;
  for (
    let index = 0;
    index < entries.length && JobsPageActions.live(canProceed);
    index++
  ) {
    const group = (number) =>
      `//legend/span[contains(text(), '(${number})') and (${title})]/../../..`;
    if (!jobsFindXPath(group(index + 1))) {
      jobsClick(
        `${group(index)}//a[contains(@id, 'Button') and contains(text(), 'Add More')]`,
        !0,
      );
      if (
        !(await JobsDOMWait.until(() => jobsFindXPath(group(index + 1)), {
          timeout: 5000,
        }))
      )
        break;
    }
    await JobsFormPipeline.bind(bindings(entries[index], group(index + 1)));
  }
}
// One EEO rule for every ATS; this form's own options decide the wording.
// Veteran status is the rules'.
async function icimsFillDisclosures(employment) {
  const control = (name) => () => {
    const native =
      document.getElementById(`CandProfileFields.${name}`) ||
      document.querySelector(`select[data-label='${name}']`);
    return (
      [
        ...(native?.parentElement.querySelectorAll(
          `a[role='combobox'],a[id$='_icimsDropdown']`,
        ) || []),
      ].find((node) =>
        JobsIcimsControls?.describe(node)?.group.includes(native),
      ) ||
      native ||
      null
    );
  };
  // Some tenants mount the optional disclosures after the page scaffold.
  await JobsDOMWait.until(() => control(`Gender`)() || control(`Race`)(), {
    timeout: 2000,
  });
  const eeo = JobsProfileAnswers.eeoSpec;
  await JobsFormPipeline.bind([
    {
      name: "gender",
      find: control(`Gender`),
      answer: eeo(`gender`, employment),
    },
    { name: "race", find: control(`Race`), answer: eeo(`race`, employment) },
    {
      name: "disability",
      find: control(`Disability`),
      answer: eeo(`disability`, employment),
    },
  ]);
}
// Each iCIMS page runs as one page pipeline: declared Profile facts, history
// and disclosures, then the rules (work authorization, sponsorship, age,
// veteran status and the questions page), AI for remaining required answers,
// review and navigation. Sign-in pages take the saved account.
async function icimsRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  accountSettings: accountSettings,
  ctx: context,
}) {
  const run = async (fill, navigation) => {
    void jobsReportJobTitle(icimsReadApplication().jobTitle);
    const profile = await getProfile();
    await jobsMountManualAnswerControls(context, [
      [
        `//div[contains(@class, 'iCIMS_CandidatePage')]//textarea`,
        `../preceding-sibling::div`,
      ],
      [
        `//div[contains(@class, 'iCIMS_QuestionsPage')]//textarea`,
        `../preceding-sibling::div`,
      ],
    ]);
    await JobsAutomatic.advance({
      profile,
      setMessage,
      canProceed: () => !context?.isInvalid,
      ...navigation,
      fill: fill && ((canProceed) => fill(profile, canProceed)),
    });
  };
  const next = () => ({
    action: autofillSettings.autoClickNextPage ? `next` : `fill`,
    target:
      jobsFindXPath(JobsPlatformConfig.structure.icims.nextXPath) || void 0,
  });
  // Cross-origin IForms receive their own content script. Run their fields
  // in that document; the portal wrapper cannot own the inner form's answers.
  // A template's Submit may be a step or a final signature, so filling alone
  // does not create navigation authority.
  if (/^\/forms\/?$/.test(window.location.pathname)) {
    jobsWaitForXPathNodes(JobsPlatformConfig.structure.icims.iformXPath).then(
      () => {
        const root = JobsPlatformConfig.root(document, "icims");
        return root && run(null, { root, action: "fill" });
      },
    );
    return;
  }
  jobsWaitForXPathNodes(
    `//main[@class= '_widget login-id' or @class= '_widget login']`,
  ).then(() =>
    jobsFillAccount([
      { find: `#username`, value: accountSettings.accountEmail },
      { find: `#password`, value: accountSettings.accountPassword },
    ]),
  );
  jobsWaitForXPathNodes(`//div[contains(@class, 'iCIMS_LoginPage')]`).then(() =>
    jobsFillAccount([
      { find: `#email`, value: accountSettings.accountEmail },
      { find: `#accept_privacy`, topic: "consent" },
      { find: `#accept_gdpr`, topic: "consent" },
    ]),
  );
  jobsWaitForXPathNodes(`//div[contains(@class, 'iCIMS_CandidatePage')]`).then(
    async () => {
      // The candidate profile also holds the portal account's login.
      await jobsFillAccount([
        {
          find: `#PersonProfileFields\\.Login`,
          value: accountSettings.accountEmail,
        },
        {
          find: `#PersonProfileFields\\.Password`,
          value: accountSettings.accountPassword,
        },
        {
          find: `#PersonProfileFields\\.Password_Confirm`,
          value: accountSettings.accountPassword,
        },
      ]);
      await run(icimsFillCandidateProfile, next());
    },
  );
  jobsWaitForXPathNodes(`//div[contains(@class, 'iCIMS_QuestionsPage')]`).then(
    () =>
      run(null, {
        root:
          /** @type {HTMLInputElement} */ (
            document.getElementById("quesp_form_submit_i")
          )?.form || void 0,
        action: autofillSettings.autoClickNextPage ? "next" : "fill",
        selector: JobsPlatformConfig.structure.icims.questionsNext,
      }),
  );
  jobsWaitForXPathNodes(`//div[contains(@class, 'iCIMS_EEOPage')]`).then(() =>
    run((profile) => icimsFillDisclosures(profile.employmentData), next()),
  );
  // The nested IForm owns its own progress; the portal must not overwrite it
  // with a blanket manual-completion status.
  autofillSettings.saveApplications &&
    jobsWaitForConfirmation("icims").then(async () => {
      (await icimsRecordApplication(), setMessage(null));
    });
}
function icimsReadApplication() {
  let e = jobsFindXPath(`//h1[contains(@class, 'iCIMS_Header')]`),
    t = document.querySelector(`link[rel='canonical']`),
    n = ``,
    r = ``;
  if (
    (e && e.textContent && (n = e.textContent), t && t.getAttribute(`href`))
  ) {
    let e = t.getAttribute(`href`) || ``;
    try {
      r = new URL(e).origin;
    } catch {
      r = ``;
    }
  }
  let i = window.location.href,
    a = i.match(/(https:\/\/[^/]+\.icims\.com\/jobs\/\d+(?:\/[^/]+)?\/job)/),
    o = a ? a[1] : ``,
    s = i.match(/(https:\/\/[^/]+\.icims\.com\/jobs)/);
  r ||= s ? s[1] + `/dashboard` : ``;
  return {
    jobsSyncProof: "ats_confirmation",
    jobTitle: n,
    jobLink: o,
    companyLink: r,
  };
}
async function icimsRecordApplication() {
  jobsSaveApplicationRecord(icimsReadApplication());
}

export {
  icimsFormatPhoneNumber,
  icimsList,
  icimsDateBindings,
  icimsFillCandidateProfile,
  icimsFillEducationHistory,
  icimsFillEmploymentHistory,
  icimsFillContact,
  icimsFillAddress,
  icimsAddEntries,
  icimsFillDisclosures,
  icimsRunApplication,
  icimsRecordApplication,
};
