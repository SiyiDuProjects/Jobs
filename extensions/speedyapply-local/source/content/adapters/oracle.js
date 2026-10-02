import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsControlFields } from "../../../src/custom/control-fields.js";
import { JobsPageActions } from "../../../src/custom/page-actions.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import { JobsDiagnostics } from "../../../src/custom/diagnostics.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import { JobsPageSession } from "../../../src/custom/control-content.js";
import { JobsQueuePage } from "../../../src/custom/queue-page.js";
import { jobsUploadResume } from "../shared/dom-controls.js";
// Oracle Recruiting Candidate Experience. The host route deliberately excludes
// Taleo, job descriptions, sign-in and candidate self-service pages.
// A field of this scope, named by its selector.
function oracleBinding(scope, name, selector, answer) {
  return { name, find: () => scope.querySelector(selector), answer };
}
async function oracleFillContact(root, profile) {
  const name = profile.nameData || {},
    address = profile.addressData || {},
    answers = JobsProfileAnswers;
  await JobsFormPipeline.bind([
    oracleBinding(
      root,
      "first-name",
      'input[name="firstName"]',
      name.firstName,
    ),
    oracleBinding(root, "last-name", 'input[name="lastName"]', name.lastName),
    oracleBinding(
      root,
      "middle-names",
      'input[name="middleNames"]',
      name.middleName,
    ),
    oracleBinding(
      root,
      "signature",
      '[role="region"][aria-label*="Signature"] input[name="fullName"]',
      [name.firstName, name.middleName, name.lastName]
        .filter(Boolean)
        .join(" "),
    ),
    oracleBinding(
      root,
      "email",
      'input[name="email"]:not([readonly])',
      profile.contactData?.email,
    ),
    oracleBinding(
      root,
      "phone",
      'input[type="tel"]',
      profile.contactData?.phoneNumber,
    ),
    oracleBinding(
      root,
      "country",
      'input[name="country"]',
      answers.countrySpec(address.country),
    ),
    oracleBinding(
      root,
      "address2",
      'input[name="addressLine2"]',
      address.line2,
    ),
    oracleBinding(
      root,
      "address1",
      'input[name="addressLine1"]',
      address.line1,
    ),
    oracleBinding(
      root,
      "state",
      'input[name="region2"]',
      answers.regionSpec(address.state, address.country),
    ),
    oracleBinding(root, "city", 'input[name="city"]', address.city),
    oracleBinding(
      root,
      "postal-code",
      'input[name="postalCode"]',
      address.postalCode,
    ),
    oracleBinding(
      root,
      "website",
      'input[name="siteLink-1"]',
      profile.websiteData?.linkedin || profile.websiteData?.personal,
    ),
  ]);
}
// A month field is a month list and a year box ("2021-09" -> September, 2021).
function oracleMonthBindings(scope, name, answer) {
  const match = String(answer || "").match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (!match || +match[2] < 1 || +match[2] > 12) return [];
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return [
    oracleBinding(
      scope,
      name + "-month",
      `input[name="${name}"][id^="month-"]`,
      months[+match[2] - 1],
    ),
    oracleBinding(
      scope,
      name + "-year",
      `input[name="${name}"][id^="year-"]`,
      match[1],
    ),
  ];
}
async function oracleFillDemographics(root, profile, canProceed = () => true) {
  const reader = JobsControlFields.create(document, () => root);
  const races = reader
    .scan()
    .filter(
      (row) =>
        row.public.type === "checkbox" &&
        row.public.question.startsWith(
          "Select the races you identify with. — ",
        ),
    );
  // Optional individual race boxes are outside the required-question pass.
  // Preserve a manual selection; let the common EEO rule choose from the
  // labelled group so this entrance agrees with supplementation.
  if (races.some((row) => row.node.checked)) return;
  await JobsFormPipeline.bind(
    [
      {
        name: "race",
        find: () => races[0]?.node,
        answer: JobsProfileAnswers.eeoSpec("race", profile.employmentData),
      },
    ],
    { canProceed },
  );
}
function oracleHistoryIdentity(label, entry) {
  return label === "Education"
    ? [entry.fieldOfStudy, entry.school]
    : label === "Experience"
      ? [entry.jobTitle, entry.company]
      : [entry.language];
}
function oracleHistoryMatches(label, entry, values) {
  const norm = (value) =>
    String(value || "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  if (label === "Experience")
    values = [
      values[0],
      String(values[1] || "").replace(
        /\s+\d{1,2}\/\d{4}\s*-\s*(?:\d{1,2}\/\d{4}|Present|Current)\s*$/i,
        "",
      ),
    ];
  const expected = oracleHistoryIdentity(label, entry);
  return expected.every(
    (value, index) =>
      value &&
      values[index] &&
      (label === "Education" && index === 1
        ? JobsProfileAnswers.schoolMatches(values[index], value)
        : norm(values[index]) === norm(value)),
  );
}
async function oracleFillHistoryEntry(region, label, entry) {
  const answers = JobsProfileAnswers,
    question = (text) => () =>
      JobsControlFields.create(document, () => region)
        .scan()
        .find((row) => row.public.question === text)?.node;
  if (label === "Education")
    return JobsFormPipeline.bind([
      oracleBinding(region, "major", 'input[name="major"]', entry.fieldOfStudy),
      // The shared degree rule over this list's own options (subtype, then level).
      {
        name: "degree",
        find: question("Degree"),
        answer: answers.degreeSpec(entry.degree),
      },
      oracleBinding(
        region,
        "school",
        'input[name="educationalEstablishment"]',
        answers.schoolSpec(entry.school),
      ),
      oracleBinding(
        region,
        "country",
        'input[name="countryCode"]',
        entry.country,
      ),
      oracleBinding(region, "city", 'input[name="city"]', entry.city),
      // A planned end date does not assert that the degree has been completed.
      ...oracleMonthBindings(region, "dateAcquired", entry.endDate),
    ]);
  if (label === "Experience")
    return JobsFormPipeline.bind(
      [
        oracleBinding(
          region,
          "employer",
          'input[name="employerName"]',
          entry.company,
        ),
        oracleBinding(
          region,
          "title",
          'input[name="jobTitle"]',
          entry.jobTitle,
        ),
        oracleBinding(
          region,
          "responsibilities",
          'textarea[name="responsibilities"]',
          entry.description,
        ),
        ...oracleMonthBindings(region, "startDate", entry.startDate),
        entry.currentlyWorkHere === true
          ? {
              name: "current",
              find: () =>
                region.querySelector(
                  'input[id^="af-checkbox-currentJobFlag-"]',
                ),
              checked: true,
            }
          : null,
        ...(entry.currentlyWorkHere === true
          ? []
          : oracleMonthBindings(region, "endDate", entry.endDate)),
      ].filter(Boolean),
    );
  return JobsFormPipeline.bind([
    oracleBinding(
      region,
      "language",
      'input[name="contentItemId"]',
      entry.language,
    ),
    ...["Reading", "Writing", "Speaking"].map((skill) => ({
      name: skill.toLowerCase(),
      find: question(skill),
      answer: answers.languageSpec(entry.proficiency, entry),
    })),
    {
      name: "native",
      find: question("Native"),
      answer:
        typeof entry.native === "boolean"
          ? answers.literalSpec("known-answer", entry.native ? "Yes" : "No")
          : null,
    },
  ]);
}
async function oracleFillHistory(root, profile, canProceed = () => true) {
  let complete = true;
  for (const [label, entries] of [
    ["Education", profile.educationData],
    ["Experience", profile.jobData],
    ["Languages", profile.languageData],
  ]) {
    const region = [...root.querySelectorAll('[role="region"]')].find(
      (node) => node.getAttribute("aria-label")?.trim() === label,
    );
    if (!region || !entries?.length) continue;
    try {
      const summaries = () => [
        ...region.querySelectorAll(
          ".apply-flow-profile-item-tile:not(.apply-flow-profile-item-tile--active) .apply-flow-profile-item-tile__summary",
        ),
      ];
      const existing = (entry) =>
        summaries().find((tile) =>
          oracleHistoryMatches(label, entry, [
            tile.querySelector(".apply-flow-profile-item-tile__summary-title")
              ?.textContent,
            tile.querySelector(
              ".apply-flow-profile-item-tile__summary-subtitle",
            )?.textContent,
          ]),
        );
      const missingDates = (entry) =>
        label === "Experience" &&
        entry.startDate &&
        entry.endDate &&
        existing(entry) &&
        !/\d{1,2}\/\d{4}\s*-\s*\d{1,2}\/\d{4}/.test(
          existing(entry).querySelector(
            ".apply-flow-profile-item-tile__summary-subtitle",
          )?.textContent || "",
        );
      const open = () => region.querySelector(".save-btn");
      let currentEntry;
      if (open()) {
        const names =
          label === "Education"
            ? ["major", "educationalEstablishment"]
            : label === "Experience"
              ? ["jobTitle", "employerName"]
              : ["contentItemId"];
        const values = names.map(
          (name) => region.querySelector(`input[name="${name}"]`)?.value,
        );
        const matches = entries.filter((entry) =>
          oracleHistoryMatches(label, entry, values),
        );
        // Only resume an editor whose record identity is unambiguous. A blank
        // or unrelated user editor is not evidence that it belongs to us.
        if (matches.length !== 1) {
          complete = false;
          continue;
        }
        currentEntry = matches[0];
      }
      const pending = [
        ...(currentEntry ? [currentEntry] : []),
        ...entries.filter(
          (entry) =>
            entry !== currentEntry && (!existing(entry) || missingDates(entry)),
        ),
      ];
      // An unidentified saved record cannot safely be deduplicated.
      if (
        !currentEntry &&
        region.querySelector(".apply-flow-profile-item-tile__edit-item-icon") &&
        !summaries().length
      ) {
        complete = false;
        continue;
      }
      for (const entry of pending) {
        if (!canProceed()) return false;
        if (!open()) {
          const add =
            existing(entry)
              ?.closest(".apply-flow-profile-item-tile")
              ?.querySelector(
                ".apply-flow-profile-item-tile__edit-item-icon",
              ) ||
            region.querySelector(
              "button.apply-flow-profile-item-tile__new-tile",
            );
          if (!add || add.disabled) {
            complete = false;
            break;
          }
          if (!JobsPageActions.click(add)) {
            complete = false;
            break;
          }
          if (
            !(await JobsDOMWait.until(() => canProceed() && open(), {
              root: region,
              timeout: 2500,
            }))
          ) {
            complete = false;
            break;
          }
        }
        await oracleFillHistoryEntry(region, label, entry);
        const reader = JobsControlFields.create(document, () => region);
        if (!reader.state().ready) {
          complete = false;
          break;
        }
        const save = open();
        if (!canProceed() || !save || save.disabled) {
          complete = false;
          break;
        }
        if (!JobsPageActions.click(save)) {
          complete = false;
          break;
        }
        if (
          !(await JobsDOMWait.until(
            () => canProceed() && !open() && existing(entry),
            { root: region, timeout: 3000 },
          ))
        ) {
          complete = false;
          break;
        }
      }
    } catch (error) {
      complete = false;
      JobsDiagnostics?.note("oracle_history_pending", region, error.message);
    }
  }
  return complete;
}
async function oracleFillApplication(root, profile, canProceed = () => true) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  await section("contact", () => oracleFillContact(root, profile));
  await section("resume", () => {
    const resume = [...root.querySelectorAll('input[type="file"]')].find(
      (node) =>
        [...(node.labels || [])].some(
          (label) => label.textContent.trim() === "Upload Resume",
        ),
    );
    if (
      resume?.closest(".attachment-upload-button--waiting") &&
      !resume.files?.length &&
      profile.resumeData?.resumeBase64
    )
      return jobsUploadResume(
        profile.resumeData,
        `input[id="${resume.id}"]`,
        false,
        root,
      );
  });
  await section("history", () => oracleFillHistory(root, profile, canProceed));
  await section("demographics", () =>
    oracleFillDemographics(root, profile, canProceed),
  );
}
// The Oracle page runs as one page pipeline: declared Profile facts and
// history, then the rules, AI for remaining required answers and review.
// A final submit is intentionally left manual until live success/consent
// paths have been validated across Oracle tenants.
async function oracleRunApplication({
  setMessage,
  getProfile,
  autofillSettings,
  ctx: context,
}) {
  const root = await JobsDOMWait.until(
    () =>
      document.querySelector(JobsPlatformConfig.structure.oracle.ready) &&
      document.querySelector(JobsPlatformConfig.structure.oracle.root),
    { root: document, timeout: 10000 },
  );
  if (!root) return;
  JobsQueuePage?.trackManualSubmit(
    root,
    JobsPlatformConfig.structure.oracle.manualSubmitText,
  );
  const url = location.href,
    canProceed = () =>
      root.isConnected && location.href === url && !context?.isInvalid;
  const profile = await getProfile();
  if (!canProceed()) return;
  const fill = () =>
    JobsAutomatic.advance({
      root,
      profile,
      action: "fill",
      retry: true,
      setMessage,
      canProceed,
      fill: (current) => oracleFillApplication(root, profile, current),
    });
  JobsPageSession?.setAutofill(fill);
  await fill();
}

export {
  oracleBinding,
  oracleFillContact,
  oracleMonthBindings,
  oracleFillDemographics,
  oracleHistoryIdentity,
  oracleHistoryMatches,
  oracleFillHistoryEntry,
  oracleFillHistory,
  oracleFillApplication,
  oracleRunApplication,
};
