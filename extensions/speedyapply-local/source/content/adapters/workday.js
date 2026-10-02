import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsControlFields } from "../../../src/custom/control-fields.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import { JobsDiagnostics } from "../../../src/custom/diagnostics.js";
import { JobsPageActions } from "../../../src/custom/page-actions.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsWorkdayControls } from "../../../src/custom/workday-controls.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import {
  jobsReportJobTitle,
  jobsSaveApplicationRecord,
} from "../shared/runtime-messages.js";
import { jobsLowercaseXPath } from "../shared/answer-helpers.js";
import { jobsMountManualAnswerControls } from "../shared/answer-ui.js";
import {
  jobsClick,
  jobsFillAccount,
  jobsFindXPath,
  jobsPdfFileFromBase64,
  jobsWaitForCssNodes,
  jobsWaitForXPathNodes,
  jobsWatchXPathPresence,
} from "../shared/dom-controls.js";
import {
  jobsFormatFullName,
  jobsProfileWebsiteEntries,
} from "../shared/profile-format.js";
async function workdayFillAccount(email, password) {
  await jobsFillAccount([
    { find: `input[data-automation-id='email']`, value: email },
    { find: `input[data-automation-id='password']`, value: password },
    { find: `input[data-automation-id='verifyPassword']`, value: password },
    {
      find: `input[data-automation-id='createAccountCheckbox']`,
      topic: "consent",
    },
  ]);
}
async function workdayAddRepeatedSection(addButtonXPath, sectionXPath) {
  const reader = JobsControlFields.create(document),
    url = location.href;
  let scope;
  const failed = () =>
    location.href !== url ||
    reader.pageFailure() ||
    (scope && !reader.visible(scope));
  const existing = jobsFindXPath(sectionXPath);
  if (existing) return existing;
  const button = await JobsDOMWait.until(
    () => (failed() ? { cancelled: true } : jobsFindXPath(addButtonXPath)),
    { timeout: 5000 },
  );
  if (!button || button.cancelled || failed())
    throw Error("Workday 添加条目前页面未就绪");
  scope =
    button.closest(
      '[data-automation-id="myExperiencePage"],[data-automation-id="applyFlowMyExpPage"]',
    ) || button.closest("main,form");
  JobsDiagnostics?.note("auto_repeat_section_add", null, sectionXPath);
  jobsClick(addButtonXPath, !0);
  const result = await JobsDOMWait.until(
    () => (failed() ? { cancelled: true } : jobsFindXPath(sectionXPath)),
    { timeout: 5000 },
  );
  if (!result || result.cancelled || failed()) {
    JobsDiagnostics?.note(
      "auto_repeat_section_failed",
      null,
      reader.pageFailure() ? "site_error" : "section_not_available",
    );
    throw Error("Workday 未成功添加条目，已停止自动填写");
  }
  return result;
}
async function workdayUploadResume(resume) {
  let t = `:is(div[aria-labelledby='Resume/CV-section'], div[data-automation-id='resumeUpload'], [data-automation-id='quickApplyPage'], [data-fkit-id='resumeAttachments--attachments'])`;
  document
    .querySelectorAll(`${t} button[data-automation-id="delete-file"]`)
    .forEach((e) => JobsPageActions.click(e));
  let n = jobsPdfFileFromBase64(resume.resumeBase64, resume.fileName),
    r = /** @type {HTMLInputElement} */ (
      document.querySelector(
        `${t} :is(input[data-automation-id='file-upload-input-ref'], input[data-automation-id='file-upload-input-ref'])`,
      )
    );
  if (r) {
    let e = new DataTransfer();
    (e.items.add(n),
      (r.files = e.files),
      JobsPageActions.dispatch(r, new Event(`change`, { bubbles: !0 })));
  }
}
async function workdayFillVoluntaryDisclosures(profile) {
  const employment = profile.employmentData,
    eeo = JobsProfileAnswers.eeoSpec;
  const results = await JobsFormPipeline.bind([
    {
      name: "race",
      find: () =>
        JobsWorkdayControls.listbox(
          document.querySelector(
            '[data-automation-id="ethnicityDropdown"],[name="ethnicity"],[data-automation-id="ethnicityPrompt"],[data-automation-id="ethnicityMulti-CheckboxGroup"]',
          ),
        ),
      answer: eeo("race", employment),
    },
    {
      name: "gender",
      find: () =>
        JobsWorkdayControls.listbox(
          document.querySelector(
            '[data-automation-id="gender"],[name="gender"]',
          ),
        ),
      answer: eeo("gender", employment),
    },
    {
      name: "hispanic",
      find: () =>
        JobsWorkdayControls.listbox(
          document.querySelector(
            '[data-automation-id="hispanicOrLatino"],[name="hispanicOrLatino"]',
          ),
        ),
      answer: eeo("hispanic", employment),
    },
    ...["agreementCheckbox", "acceptTermsAndAgreements"].map((id) => ({
      name: id,
      find: () =>
        document.querySelector(
          '[data-automation-id="' + id + '"],[name="' + id + '"]',
        ),
      topic: "consent",
    })),
  ]);
  return results[0] || null;
}
async function workdayFillExperiencePage(profile, canProceed = () => true) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  await section(`employment`, () =>
    workdayFillEmploymentHistory(profile.jobData),
  );
  await section(`education`, () =>
    workdayFillEducationHistory(profile.educationData),
  );
  await section(
    `resume`,
    () =>
      profile.resumeData?.resumeBase64 &&
      workdayUploadResume(profile.resumeData),
  );
  await section(`languages`, () => workdayFillLanguages(profile.languageData));
  await section(
    `skills`,
    () =>
      profile.skillsData?.length > 0 && workdayFillSkills(profile.skillsData),
  );
  await section(`websites`, () => workdayFillWebsites(profile.websiteData));
}
// A Workday Start/End month: the section's date wrapper (month and year).
function workdayMonthField(section, edge) {
  return () => {
    const field = jobsFindXPath(
      `${section}//div[@data-automation-id='formField-${edge}Date']`,
    );
    return (
      /** @type {Element} */ (field)?.querySelector(
        '[data-automation-id="dateInputWrapper"]',
      ) || field
    );
  };
}
async function workdayFillEmploymentHistory(employmentEntries) {
  const lower = jobsLowercaseXPath(`@aria-labelledby`),
    workSection = `(contains(${lower}, 'work') or contains(${lower}, 'experience'))`;
  if (
    !jobsFindXPath(
      `//button[(contains(@aria-label, 'Add') or contains(@aria-label, 'Add Another')) and (contains(@aria-label, 'Work') or contains(@aria-label, 'Experience') or contains(@aria-label, 'Professional'))] | //div[${workSection} and contains(@aria-labelledby, 'section') and not(contains(${lower}, 'network'))]`,
    )
  )
    return;
  for (const [index, entry] of employmentEntries.entries()) {
    const section = `//div[@data-automation-id='workExperience-${index + 1}' or (${workSection} and contains(@aria-labelledby,'${index + 1}-panel'))]`;
    if (!jobsFindXPath(section))
      await workdayAddRepeatedSection(
        `//button[contains(@aria-label, 'Add') and (contains(@aria-label, 'Work') or contains(@aria-label, 'Experience') or contains(@aria-label, 'Professional')) and not(@disabled)] | //div[${workSection} and contains(@aria-labelledby, 'section')]//button[@data-automation-id='add-button']`,
        section,
      );
    await JobsFormPipeline.bind([
      {
        name: `employment-${index}-title`,
        find: `${section}//input[@data-automation-id='jobTitle' or @name='jobTitle']`,
        answer: entry.jobTitle,
        replace: true,
      },
      {
        name: `employment-${index}-company`,
        find: `${section}//input[@data-automation-id='company' or @name='companyName']`,
        answer: entry.company,
        replace: true,
      },
      {
        name: `employment-${index}-location`,
        find: `${section}//input[@data-automation-id='location' or @name='location']`,
        answer: entry.location,
        replace: true,
      },
      {
        name: `employment-${index}-start`,
        find: workdayMonthField(section, `start`),
        answer: entry.startDate,
        replace: true,
      },
      {
        name: `employment-${index}-end`,
        find: workdayMonthField(section, `end`),
        answer: entry.endDate,
        replace: true,
      },
      {
        name: `employment-${index}-current`,
        find: `${section}//input[@data-automation-id='currentlyWorkHere' or @name='currentlyWorkHere']`,
        checked: entry.currentlyWorkHere ? true : undefined,
      },
      {
        name: `employment-${index}-description`,
        find: `${section}//textarea[@data-automation-id='description'] | ${section}//div[@data-automation-id='formField-roleDescription']//textarea`,
        answer: entry.description,
        replace: true,
      },
    ]);
  }
}
async function workdayFillEducationHistory(educationEntries) {
  if (
    !jobsFindXPath(
      "//button[contains(@aria-label,'Education')] | //div[contains(@aria-labelledby,'Education') or contains(@aria-labelledby,'education')]",
    )
  )
    return;
  for (const [index, entry] of educationEntries.entries()) {
    const scope =
      "//div[@data-automation-id='education-" +
      (index + 1) +
      "' or (contains(" +
      jobsLowercaseXPath("@aria-labelledby") +
      ",'education') and contains(@aria-labelledby,'" +
      (index + 1) +
      "-panel'))]";
    if (!jobsFindXPath(scope))
      await workdayAddRepeatedSection(
        "//button[contains(@aria-label,'Add') and contains(@aria-label,'Education') and not(@disabled)] | //div[contains(" +
          jobsLowercaseXPath("@aria-labelledby") +
          ",'education') and contains(@aria-labelledby,'section')]//button[@data-automation-id='add-button']",
        scope,
      );
    const find = (path) => () => jobsFindXPath(scope + path);
    await JobsFormPipeline.bind([
      {
        name: "education-" + index + "-school",
        find: () =>
          find(
            "//input[@data-automation-id='school' or @name='schoolName']",
          )() ||
          find(
            "//div[@data-automation-id='formField-schoolItem' or @data-automation-id='formField-school']//input[@data-uxi-widget-type='selectinput']",
          )(),
        answer: JobsProfileAnswers.schoolSpec(entry.school),
      },
      {
        name: "education-" + index + "-degree",
        find: () =>
          JobsWorkdayControls.listbox(
            find(
              "//button[(@data-automation-id='degree' or @name='degree') and not(@disabled)]",
            )(),
          ),
        answer: JobsProfileAnswers.degreeSpec(entry.degree),
        replace: true,
      },
      {
        name: "education-" + index + "-major",
        find: find(
          "//div[@data-automation-id='formField-field-of-study' or @data-automation-id='formField-fieldOfStudy']//input[@data-uxi-widget-type='selectinput']",
        ),
        answer: JobsProfileAnswers.knownSpec(
          "Field of study",
          entry.fieldOfStudy,
        ),
      },
      {
        name: "education-" + index + "-start",
        find: find(
          '//div[@data-automation-id="formField-startDate" or @data-automation-id="formField-firstYearAttended"]//input',
        ),
        answer: entry.startDate?.split("-")[0],
        replace: true,
      },
      {
        name: "education-" + index + "-end",
        find: () =>
          find('//input[@data-automation-id="formField-endDate"]')() ||
          find(
            '//div[@data-automation-id="formField-lastYearAttended"]//input',
          )(),
        answer: entry.endDate?.split("-")[0],
        replace: true,
      },
      {
        name: "education-" + index + "-gpa",
        find: () =>
          find('//input[@data-automation-id="gpa"]')() ||
          find('//div[@data-automation-id="formField-gradeAverage"]//input')(),
        answer: entry.gpa,
        replace: true,
      },
    ]);
  }
}
async function workdayFillSkills(skills) {
  const results = await JobsFormPipeline.bind([
    {
      name: "skills",
      find: () =>
        document.querySelector(
          ':is(div[data-automation-id="formField-skillsPrompt"],div[data-automation-id="formField-skills"]) input[data-uxi-widget-type="selectinput"]',
        ),
      answers: skills.map((skill) => JobsProfileAnswers.skillSpec(skill)),
    },
  ]);
  return results[0] || null;
}
async function workdayFillLanguages(languages) {
  if (
    !jobsFindXPath(
      `//button[(contains(@aria-label, 'Add') or contains(@aria-label, 'Add Another')) and contains(@aria-label, 'Language')] | //div[@aria-labelledby='Languages-section']`,
    )
  )
    return;
  for (const [index, entry] of languages.entries()) {
    const section = `//div[@data-automation-id='language-${index + 1}' or @aria-labelledby='Languages-${index + 1}-panel']`;
    if (!jobsFindXPath(section))
      await workdayAddRepeatedSection(
        `//button[(contains(@aria-label, 'Add') or contains(@aria-label, 'Add Another')) and contains(@aria-label, 'Language') and not(@disabled)] | //div[@aria-labelledby='Languages-section']//button[@data-automation-id='add-button']`,
        section,
      );
    await JobsFormPipeline.bind([
      {
        name: `language-${index}`,
        find: () =>
          JobsWorkdayControls.listbox(
            jobsFindXPath(
              `${section}//button[@data-automation-id='language' or @name='language']`,
            ),
          ),
        answer: JobsProfileAnswers.literalSpec("known-answer", entry.language),
      },
      {
        name: `language-${index}-native`,
        find: `${section}//input[@data-automation-id="nativeLanguage" or @name="native"]`,
        checked: entry.fluent ? true : undefined,
      },
    ]);
    if (!entry.proficiency) continue;
    // One proficiency list per skill (reading, speaking, writing...).
    const level = (skill) =>
      `${section}//button[@data-automation-id="languageProficiency-${skill}"] | (${section}//button[contains(@id,'language') and not(@name='language')])[${skill + 1}]`;
    for (let skill = 0; jobsFindXPath(level(skill)); skill++)
      await JobsFormPipeline.bind([
        {
          name: `language-${index}-level-${skill}`,
          find: () =>
            JobsWorkdayControls.listbox(jobsFindXPath(level(skill)), {
              language: true,
            }),
          answer: JobsProfileAnswers.languageSpec(entry.proficiency),
        },
      ]);
  }
}
async function workdayFillWebsites(websites) {
  await JobsFormPipeline.bind([
    {
      name: "linkedin",
      find: `input[data-automation-id='linkedinQuestion'], input[name='linkedInAccount']`,
      answer: websites.linkedin,
      replace: true,
    },
    {
      name: "github",
      find: `input[data-automation-id='githubQuestion'], input[name='githubAccount']`,
      answer: websites.github,
      replace: true,
    },
    {
      name: "personal-website",
      find: `input[data-automation-id='personalWebsiteQuestion'], input[name='personalWebsite']`,
      answer: websites.personal,
      replace: true,
    },
    {
      name: "twitter",
      find: `input[data-automation-id='twitterQuestion'], input[name='twitterAccount']`,
      answer: websites.twitter,
      replace: true,
    },
  ]);
  if (
    !jobsFindXPath(
      `//button[(contains(@aria-label, 'Add') or contains(@aria-label, 'Add Another')) and (contains(@aria-label, 'Website') or contains(@aria-label, 'Portfolio'))] | //div[@aria-labelledby='Websites-section']`,
    )
  )
    return;
  // Structure: one website panel per URL (at most six), added with the section's button.
  for (const [index, url] of jobsProfileWebsiteEntries(websites)
    .map((entry) => entry.url)
    .slice(0, 6)
    .entries()) {
    const section = `//div[@data-automation-id='websitePanelSet-${index + 1}' or @aria-labelledby='Websites-${index + 1}-panel']`;
    if (!jobsFindXPath(section))
      await workdayAddRepeatedSection(
        `//button[(contains(@aria-label, 'Add') or contains(@aria-label, 'Add Another')) and (contains(@aria-label, 'Website') or contains(@aria-label, 'Portfolio')) and not(@disabled)] | //div[@aria-labelledby='Websites-section']//button[@data-automation-id='add-button']`,
        section,
      );
    await JobsFormPipeline.bind([
      {
        name: `website-${index}`,
        find: `${section}//input[@data-automation-id='website' or @name='url']`,
        answer: url,
        replace: true,
      },
    ]);
  }
}
async function workdayFillInformationPage(profile, canProceed = () => true) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  await section(`source`, () => workdayFillPriorEmploymentAndSource(profile));
  await section(`country`, () =>
    workdaySelectCountryAndWait(profile.addressData.country),
  );
  await section(`name`, () => workdayFillName(profile.nameData));
  await section(`address`, () => workdayFillAddress(profile.addressData));
  await section(`contact`, () => workdayFillContact(profile.contactData));
}
async function workdayFillPriorEmploymentAndSource(profile) {
  const results = await JobsFormPipeline.bind([
    {
      name: "source",
      find: () =>
        JobsWorkdayControls.listbox(
          document.querySelector(
            'button[data-automation-id="sourceDropdown"]:not([disabled]),button[id="source--source"]:not([disabled])',
          ),
        ) ||
        document.querySelector(
          ':is(div[data-automation-id="formField-sourcePrompt"],div[data-automation-id="formField-source"]) input[data-uxi-widget-type="selectinput"]',
        ),
      answer: JobsProfileAnswers.recruitingSourceSpec(profile),
    },
  ]);
  return results[0] || null;
}
async function workdaySelectCountryAndWait(country) {
  const results = await JobsFormPipeline.bind([
    {
      name: "country",
      find: () =>
        JobsWorkdayControls.listbox(
          document.querySelector(
            'button[data-automation-id="countryDropdown"]:not([disabled]),button[id="country--country"]:not([disabled])',
          ),
        ),
      answer: JobsProfileAnswers.countrySpec(country),
      after: (node, canProceed) =>
        JobsFormPipeline.settled(
          node.closest(
            '[data-automation-id="applyFlowMyInfoPage"],[data-automation-id="contactInformationPage"]',
          ) || document.body,
          { canProceed },
        ),
    },
  ]);
  return results[0] || null;
}
async function workdayFillName(name) {
  const find = (selector) => () => document.querySelector(selector);
  const results = await JobsFormPipeline.bind([
    {
      name: "first-name",
      find: find(
        'input[data-automation-id="legalNameSection_firstName"],#name--legalName--firstName',
      ),
      answer: name.firstName,
      replace: true,
    },
    {
      name: "last-name",
      find: find(
        'input[data-automation-id="legalNameSection_lastName"],#name--legalName--lastName',
      ),
      answer: name.lastName,
      replace: true,
    },
    ...(name.preferredName
      ? [
          {
            name: "preferred-name-enabled",
            find: find(
              'input[data-automation-id="preferredNameCheckbox"],#name--preferredCheck',
            ),
            checked: true,
            after: (_node, canProceed) =>
              JobsDOMWait.until(
                () =>
                  !canProceed()
                    ? { cancelled: true }
                    : document.querySelector(
                        '[data-automation-id="preferredNameSection"],#Preferred-Name-section',
                      ),
                { timeout: 5000 },
              ),
          },
          {
            name: "preferred-first-name",
            find: find(
              'input[data-automation-id="preferredNameSection_firstName"],#name--preferredName--firstName',
            ),
            answer: name.preferredFirstName || name.firstName,
            replace: true,
          },
          {
            name: "preferred-last-name",
            find: find(
              'input[data-automation-id="preferredNameSection_lastName"],#name--preferredName--lastName',
            ),
            answer: name.preferredLastName || name.lastName,
            replace: true,
          },
        ]
      : []),
  ]);
  return results[0] || null;
}
async function workdayFillAddress(address) {
  const results = await JobsFormPipeline.bind([
    ...[
      ["line1", "addressLine1"],
      ["line2", "addressLine2"],
      ["city", "city"],
      ["postalCode", "postalCode"],
    ].map(([key, id]) => ({
      name: "address-" + key,
      find: () =>
        document.querySelector(
          'input[data-automation-id="addressSection_' +
            id +
            '"],#address--' +
            id,
        ),
      answer: address[key],
      replace: true,
    })),
    {
      name: "state",
      find: () =>
        JobsWorkdayControls.listbox(
          document.querySelector(
            'button[data-automation-id="addressSection_countryRegion"]:not([disabled]),#address--countryRegion',
          ),
        ),
      answer: JobsProfileAnswers.regionSpec(address.state, address.country),
    },
  ]);
  return results[0] || null;
}
async function workdayFillContact(contact) {
  const results = await JobsFormPipeline.bind([
    {
      name: "email",
      find: () =>
        document.querySelector(
          'input[data-automation-id="email"],input[name="emailAddress"]',
        ),
      answer: contact.email,
      replace: true,
    },
    {
      name: "phone-type",
      find: () =>
        JobsWorkdayControls.listbox(
          document.querySelector(
            'button[data-automation-id="phone-device-type"]:not([disabled]),button[id="phoneNumber--phoneType"]:not([disabled])',
          ),
        ),
      answer: JobsProfileAnswers.phoneTypeSpec(contact.phoneDeviceType),
    },
    {
      name: "phone",
      find: () =>
        document.querySelector(
          'input[data-automation-id="phone-number"],#phoneNumber--phoneNumber',
        ),
      answer: contact.phoneNumber,
      replace: true,
    },
  ]);
  return results[0] || null;
}
async function workdayFillQuestionnaire(
  profile,
  pageXPath,
  saveResponses,
  context,
  canProceed = () => true,
) {
  const scope = jobsFindXPath(pageXPath);
  if (!scope) return;
  await jobsMountManualAnswerControls(context, [
    ["//textarea", "ancestor::fieldset[1]//legend"],
  ]);
}
async function workdayReadUnresolvedResponses(pageXPath, answered) {
  return JobsFormPipeline.unresolved(jobsFindXPath(pageXPath), answered);
}
async function workdayHandleReviewPage(settings, jobsProfile, setMessage) {
  JobsDiagnostics?.note(
    "review_submit_policy",
    null,
    settings.autoSubmit ? "auto_submit_enabled" : "auto_submit_disabled",
  );
  if (!settings.autoSubmit) setMessage("ready-submit");
  (await workdayTrackReviewSubmitClick(Boolean(settings.saveApplications)),
    settings.autoSubmit &&
      (await JobsAutomatic.advance({
        root: document.querySelector(
          JobsPlatformConfig.structure.workday.reviewRoot,
        ),
        profile: jobsProfile,
        review: true,
        action: "submit",
        selector: JobsPlatformConfig.structure.workday.next,
        setMessage,
      })));
}
async function workdayTrackReviewSubmitClick(record = true) {
  let e = document.querySelector(`h3, [data-automation-id='jobTitleHeading']`),
    t = /** @type {HTMLAnchorElement} */ (
      document.querySelector(`a[data-automation-id='logoLink']`)
    ),
    n = ``,
    r = ``,
    i = window.location.href;
  if ((e && e.textContent && (n = e.textContent), t && t.href)) r = t.href;
  else {
    let e = i.match(/(https?:\/\/[^/]+\/(?:en-US\/)?[^/]+)/);
    r = e ? e[1] : ``;
  }
  void jobsReportJobTitle(n, i);
  if (!record) return;
  let a = i.substring(0, i.indexOf(`/apply`)),
    o = await jobsWaitForCssNodes(
      JobsPlatformConfig.structure.workday.nextEnabled,
    );
  o.length > 0 &&
    o[0].addEventListener(`click`, () => {
      document.querySelector(JobsPlatformConfig.structure.workday.reviewRoot) &&
        jobsSaveApplicationRecord({
          jobsSyncProof: "submit_attempt",
          jobTitle: n,
          jobLink: a,
          companyLink: r,
        });
    });
}
async function workdayFillSelfIdentification(profile) {
  const results = await JobsFormPipeline.bind([
    {
      name: "language",
      find: () =>
        JobsWorkdayControls.listbox(
          document.querySelector('[data-automation-id="language"]'),
        ),
      answer: JobsProfileAnswers.disclosureLanguage(profile),
    },
    {
      name: "signature-name",
      find: () =>
        document.querySelector('[data-automation-id="name"],[name="name"]'),
      answer: jobsFormatFullName(profile.nameData),
      replace: true,
    },
    {
      name: "signature-date",
      find: () =>
        document.querySelector('[data-automation-id="dateInputWrapper"]'),
      answer: () => JobsProfileAnswers.today(),
      replace: true,
    },
    {
      name: "disability",
      find: () =>
        document.querySelector(
          '[data-automation-id="disability"],[data-automation-id="disabilityStatus-CheckboxGroup"]',
        ),
      answer: JobsProfileAnswers.eeoSpec("disability", profile.employmentData),
    },
  ]);
  return results[0] || null;
}
async function workdayRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  accountSettings: accountSettings,
  ctx: context,
}) {
  // Every step is one pipeline run started here; status reports never start another.
  const next = JobsPlatformConfig.structure.workday.next;
  const loaded = (xpath) =>
    jobsWaitForXPathNodes(
      `${xpath}[not(contains(${jobsLowercaseXPath(`.`)}, 'loading')) or contains(${jobsLowercaseXPath(`.`)}, 'uploading')]`,
    );
  // Status belongs to the step's run and, after it, to the status watcher
  // (field errors are declared in platform-config). This adapter reports
  // only facts no run knows: a step that could not start, a review policy.
  async function a(t, n) {
    await loaded(n);
    await JobsFormPipeline.settled(
      /** @type {Element} */ (jobsFindXPath(n))?.closest(`form,main`) ||
        document.body,
    );
    await t();
  }
  async function o(r, i) {
    try {
      await loaded(i);
      await JobsFormPipeline.settled(jobsFindXPath(i));
      // The step may already be gone (Apply Manually, a quick continue); a
      // missing step is not a manual-completion status for the next one.
      if (!jobsFindXPath(i)) return;
      let a = await getProfile();
      JobsDiagnostics?.note("auto_adapter_preparing", null, i);
      await JobsAutomatic.advance({
        root: jobsFindXPath(i),
        profile: a,
        setMessage: setMessage,
        action:
          autofillSettings && autofillSettings.autoClickNextPage
            ? "next"
            : "fill",
        selector: next,
        fill: (current) => r(a, current),
      });
    } catch (error) {
      JobsDiagnostics?.note(
        "auto_adapter_failed",
        null,
        error.message || String(error),
      );
      setMessage(
        JobsControlFields.create(document).pageFailure()
          ? "site-error"
          : "complete-manually",
      );
    }
  }
  if (accountSettings.accountEmail || accountSettings.accountPassword) {
    let e = `//*[@data-automation-id='signInSubmitButton']`;
    jobsWatchXPathPresence(e, () =>
      a(
        () =>
          workdayFillAccount(
            accountSettings.accountEmail,
            accountSettings.accountPassword,
          ),
        e,
      ),
    );
    let t = `//*[@data-automation-id='createAccountSubmitButton']`;
    jobsWatchXPathPresence(t, () =>
      a(
        () =>
          workdayFillAccount(
            accountSettings.accountEmail,
            accountSettings.accountPassword,
          ),
        t,
      ),
    );
    let n = `//*[@data-automation-id='resetPasswordButton']`;
    jobsWatchXPathPresence(n, () =>
      a(
        () =>
          workdayFillAccount(
            accountSettings.accountEmail,
            accountSettings.accountPassword,
          ),
        n,
      ),
    );
  }
  jobsWaitForXPathNodes(`//*[@data-automation-id='applyManually']`).then(() => {
    autofillSettings.autoClickNextPage &&
      jobsClick(`//*[@data-automation-id='applyManually']`, !0);
  });
  let s = JobsPlatformConfig.structure.workday.resumeRootXPath;
  jobsWaitForXPathNodes(s).then(() =>
    o(
      (e, c) =>
        JobsFormPipeline.section(
          `resume`,
          () => e.resumeData?.resumeBase64 && workdayUploadResume(e.resumeData),
          { canProceed: c },
        ),
      s,
    ),
  );
  let c = JobsPlatformConfig.structure.workday.infoRootXPath;
  jobsWaitForXPathNodes(c).then(() =>
    o((e, n) => workdayFillInformationPage(e, n), c),
  );
  let l = JobsPlatformConfig.structure.workday.experienceRootXPath;
  jobsWaitForXPathNodes(l).then(() =>
    o((e, n) => workdayFillExperiencePage(e, n), l),
  );
  let u = JobsPlatformConfig.structure.workday.firstQuestionsRootXPath;
  jobsWaitForXPathNodes(u).then(() =>
    o(
      (e, n) =>
        workdayFillQuestionnaire(
          e,
          u,
          autofillSettings.saveResponses,
          context,
          n,
        ),
      u,
    ),
  );
  let d = JobsPlatformConfig.structure.workday.secondQuestionsRootXPath;
  jobsWaitForXPathNodes(d).then(() =>
    o(
      (e, n) =>
        workdayFillQuestionnaire(
          e,
          d,
          autofillSettings.saveResponses,
          context,
          n,
        ),
      d,
    ),
  );
  let f = JobsPlatformConfig.structure.workday.disclosuresRootXPath;
  jobsWaitForXPathNodes(f).then(() =>
    o(
      (e, n) =>
        JobsFormPipeline.section(
          `disclosures`,
          () => workdayFillVoluntaryDisclosures(e),
          { canProceed: n },
        ),
      f,
    ),
  );
  let p = JobsPlatformConfig.structure.workday.identityRootXPath;
  (jobsWaitForXPathNodes(p).then(() =>
    o(
      (e, n) =>
        JobsFormPipeline.section(
          `self-identification`,
          () => workdayFillSelfIdentification(e),
          { canProceed: n },
        ),
      p,
    ),
  ),
    jobsWaitForXPathNodes(
      JobsPlatformConfig.structure.workday.reviewRootXPath,
    ).then(async () => {
      try {
        await workdayHandleReviewPage(
          autofillSettings,
          autofillSettings.autoSubmit ? await getProfile() : null,
          setMessage,
        );
      } catch (error) {
        JobsDiagnostics?.note(
          "auto_blocked",
          null,
          error.message || String(error),
        );
        setMessage("complete-manually");
      }
    }));
}

export {
  workdayFillAccount,
  workdayAddRepeatedSection,
  workdayUploadResume,
  workdayFillVoluntaryDisclosures,
  workdayFillExperiencePage,
  workdayMonthField,
  workdayFillEmploymentHistory,
  workdayFillEducationHistory,
  workdayFillSkills,
  workdayFillLanguages,
  workdayFillWebsites,
  workdayFillInformationPage,
  workdayFillPriorEmploymentAndSource,
  workdaySelectCountryAndWait,
  workdayFillName,
  workdayFillAddress,
  workdayFillContact,
  workdayFillQuestionnaire,
  workdayReadUnresolvedResponses,
  workdayHandleReviewPage,
  workdayTrackReviewSubmitClick,
  workdayFillSelfIdentification,
  workdayRunApplication,
};
