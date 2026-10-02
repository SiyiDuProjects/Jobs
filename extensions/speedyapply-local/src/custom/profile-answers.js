import { JobsOptionMatch } from "./option-match.js";
import { JobsAnswerPolicy } from "./answer-policy.js";
export var JobsProfileAnswers;
let initialized = false;
export function initializeProfileAnswers() {
  if (initialized) return;
  initialized = true;
  (() => {
    const normalize = (value) =>
      String(value ?? "")
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[’‘]/g, "'")
        .replace(/\s+/g, " ")
        .trim();
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
    const degreeKey = (value) =>
      normalize(value)
        .replace(/[.'()]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    const degreeLevels = {
      bachelor: [
        "Bachelor",
        "Bachelor's",
        "Bachelors",
        "Bachelor's Degree",
        "Bachelor Degree",
        "Bachelors Degree",
      ],
      master: [
        "Master",
        "Master's",
        "Masters",
        "Master's Degree",
        "Master Degree",
        "Masters Degree",
      ],
      associate: [
        "Associate",
        "Associate's",
        "Associates",
        "Associate's Degree",
        "Associate Degree",
        "Associates Degree",
      ],
      doctorate: [
        "Doctorate",
        "Doctorate Degree",
        "Doctoral Degree",
        "Doctoral",
      ],
    };
    /** @type {Array<[string,string[]]>} */
    const degreeTypes = [
      [
        "bachelor",
        [
          "Bachelor of Arts",
          "Bachelor of Arts (B.A.)",
          "Bachelor of Arts (BA)",
          "BA",
          "B.A.",
        ],
      ],
      [
        "bachelor",
        [
          "Bachelor of Science",
          "Bachelor of Science (B.S.)",
          "Bachelor of Science (BS)",
          "BS",
          "B.S.",
          "BSc",
          "B.Sc.",
        ],
      ],
      ["master", ["Master of Arts", "Master of Arts (M.A.)", "MA", "M.A."]],
      [
        "master",
        [
          "Master of Science",
          "Master of Science (M.S.)",
          "MS",
          "M.S.",
          "MSc",
          "M.Sc.",
        ],
      ],
      [
        "master",
        [
          "Master of Business Administration",
          "Master of Business Administration (MBA)",
          "MBA",
        ],
      ],
      [
        "associate",
        ["Associate of Arts", "Associate of Arts (A.A.)", "AA", "A.A."],
      ],
      [
        "associate",
        ["Associate of Science", "Associate of Science (A.S.)", "AS", "A.S."],
      ],
      [
        "doctorate",
        [
          "Doctor of Philosophy",
          "Doctor of Philosophy (Ph.D.)",
          "PhD",
          "Ph.D.",
        ],
      ],
      [
        "doctorate",
        ["Doctor of Pharmacy", "Doctor of Pharmacy (PharmD)", "PharmD"],
      ],
    ];
    function degreeTiers(value) {
      const key = degreeKey(value),
        type = degreeTypes.find(([, labels]) =>
          labels.some((label) => degreeKey(label) === key),
        );
      if (type) return [type[1], degreeLevels[type[0]]];
      const level = Object.values(degreeLevels).find((labels) =>
        labels.some((label) => degreeKey(label) === key),
      );
      if (level) return [level];
      if (["high school", "high school diploma", "hs"].includes(key))
        return [["High School", "High School Diploma", "HS"]];
      if (
        [
          "ged",
          "general education development",
          "general educational development",
        ].includes(key)
      )
        return [
          [
            "GED",
            "G.E.D.",
            "General Education Development",
            "General Educational Development",
          ],
        ];
      return [[String(value ?? "").trim()]];
    }
    // The one degree rule for every ATS and every entrance (first fill,
    // supplement, AI/remote). A confirmed subtype is preferred; a level-only
    // answer never invents a subtype. Site wording ("College - Bachelor of Arts",
    // "Bachelor's Degree", "Doctoral") is absorbed by equality and safe
    // whole-phrase containment. A generic level may match a prefixed Degree
    // label, but never a named subtype such as Bachelor of Science.
    // Catalog labels such as Workday's "Bachelors of Arts or Science (Bachelors)"
    // name the level in a trailing parenthesis. Such a label is the Profile's
    // degree at that level when it names no subject or the Profile's subject.
    const levelAlias = (alias) =>
      Object.values(degreeLevels).some((labels) =>
        labels.some((label) => degreeKey(label) === degreeKey(alias)),
      );
    function catalogDegree(label, alias, subject) {
      const parts = normalize(label).match(/^(.*?)\s*\(([^()]+)\)$/);
      if (
        !parts ||
        !levelAlias(alias) ||
        degreeKey(parts[2]) !== degreeKey(alias)
      )
        return false;
      const name = degreeKey(parts[1]);
      return !subject || new RegExp("\\b" + subject + "\\b").test(name);
    }
    function degreeSpec(value) {
      const tiers = degreeTiers(value);
      const subject =
        tiers.length > 1
          ? degreeKey(tiers[0][0]).match(
              /^(?:bachelor|master|associate|doctor) of (.+)$/,
            )?.[1]
          : null;
      return {
        topic: "degree",
        tiers,
        equals: (label, alias) =>
          degreeKey(label) === degreeKey(alias) ||
          catalogDegree(label, alias, subject),
        containsTier: tiers.length - 1,
        containsWhen: (tier, alias) =>
          (tiers.length > 1 && tier === 0) || /\bdegree\b/i.test(alias),
      };
    }
    function educationTypeSpec(entry = {}) {
      if (entry.schoolType)
        return literalSpec("education_type", entry.schoolType);
      const tiers = degreeTiers(entry.degree),
        level = Object.keys(degreeLevels).find((key) =>
          tiers.some(
            (tier) =>
              tier === degreeLevels[key] ||
              tier.some((value) =>
                degreeLevels[key].some(
                  (alias) => degreeKey(alias) === degreeKey(value),
                ),
              ),
          ),
        );
      // Degree level supports a broad school category. An associate degree
      // cannot establish vocational schooling, nor a doctorate a specialist school.
      const value =
        level === "bachelor" || level === "associate"
          ? "College / University"
          : level === "master" || level === "doctorate"
            ? "Graduate School"
            : /^(?:high school|ged)$/i.test(entry.degree || "")
              ? "High School"
              : null;
      return literalSpec("education_type", value);
    }
    function highestEducation(entries = []) {
      if (entries.length === 1) return entries[0];
      const levels = [
        "highschool",
        "associate",
        "bachelor",
        "master",
        "doctorate",
      ];
      const rank = (entry) => {
        const tiers = degreeTiers(entry.degree);
        const level = Object.keys(degreeLevels).find((key) =>
          tiers.some((tier) => tier === degreeLevels[key]),
        );
        return level
          ? levels.indexOf(level)
          : /^(?:high school|high school diploma|ged)$/i.test(
                entry.degree || "",
              )
            ? 0
            : -1;
      };
      const ranked = entries.map((entry) => ({ entry, rank: rank(entry) }));
      if (ranked.some((item) => item.rank < 0)) return null;
      const highest = Math.max(...ranked.map((item) => item.rank)),
        matches = ranked.filter((item) => item.rank === highest);
      return matches.length === 1 ? matches[0].entry : null;
    }
    // One EEO vocabulary for every ATS (gender, race, Hispanic/Latino, disability,
    // veteran): the Profile value's own wording, then the site wordings the
    // adapters had collected. Only known presentation/country suffixes are
    // equivalent; "Asian" must not become "South Asian", nor "Male" transgender.
    // Empty legacy Profile choices mean decline; absent facts remain unknown.
    const declineWords = [
      "Decline to self-identify",
      "Decline To Self Identify",
      "Decline to Self Identify",
      "I choose not to disclose",
      "I do not wish to disclose",
      "I do not wish to answer",
      "I don't wish to answer",
      "I do not want to answer",
      "Prefer not to say",
      "Prefer not to answer",
      "I prefer not to answer",
      "I prefer not to disclose",
      "Prefer not to disclose",
      "I don't wish to disclose",
      "Decline to state",
      "Decline to answer",
      "I decline self-identification",
      "I choose not to self-identify",
      "I do not wish to self-identify",
      "I choose not to identify",
      "Not declared",
      "Not specified",
      "Not disclosed",
      "Opt Out",
      "Decline",
    ];
    const raceWords = {
      "American Indian or Alaska Native": [
        "American Indian or Alaska Native",
        "American Indian or Alaskan Native",
        "Native American or Alaska Native",
        "Native American or Alaskan Native",
        "Indigenous Peoples, First Nations, Native American, or Alaska Native",
      ],
      Asian: ["Asian", "Asian or Asian American"],
      "Black or African American": [
        "Black or African American",
        "African American",
        "Black",
      ],
      "Hispanic or Latino": [
        "Hispanic or Latino",
        "Hispanic, Latino, or Spanish origin",
        "Hispanic/Latino",
        "Hispanic",
      ],
      "Native Hawaiian or Other Pacific Islander": [
        "Native Hawaiian or Other Pacific Islander",
        "Native Hawaiian / Other Pacific Islander",
        "Native Hawaiian or Pacific Islander",
      ],
      White: ["White", "White / Caucasian", "Caucasian"],
      "Two or More Races": [
        "Two or More Races",
        "Two or more races",
        "Multiracial",
      ],
    };
    const undisclosed = (value) =>
      value === "" ||
      value === "I choose not to disclose" ||
      value === "undisclosed";
    const eeoKey = (value) =>
      normalize(value)
        .replace(/[.!]+$/, "")
        .replace(
          /\s*\((?:united states(?: of america)?|not hispanic or latino)\)/g,
          "",
        )
        .replace(/,\s*not hispanic or latino$/, "")
        .replace(/african-american/g, "african american")
        .replace(/hispanic\s*\/\s*latino/g, "hispanic or latino")
        .trim();
    function eeoSpec(topic, employment = {}, context = {}) {
      const spec = (tiers, extra = {}) => ({
        topic: "eeo:" + topic,
        tiers,
        equals: (label, alias) =>
          (!/\bnot hispanic or latino\b/i.test(label) ||
            topic === "hispanic" ||
            employment.hispanicOrLatino === false) &&
          eeoKey(label) === eeoKey(alias),
        ...extra,
      });
      const decline = () => spec([declineWords], { declined: true });
      if (topic === "ethnicity") {
        // Some forms split ethnicity (Hispanic/Latino) from race; others put
        // race categories in this list. Only options supported by either fact
        // are eligible, and the explicit ethnicity choice takes precedence.
        const hispanic = eeoSpec("hispanic", employment),
          race = eeoSpec("race", employment);
        if (!hispanic && !race) return null;
        return spec([...(hispanic?.tiers || []), ...(race?.tiers || [])], {
          answer: race?.tiers[0][0] || hispanic?.tiers[0][0],
        });
      }
      if (topic === "gender") {
        const value = employment.gender;
        if (value === "Male") return spec([["Male", "Man"]]);
        if (value === "Female") return spec([["Female", "Woman"]]);
        if (value === "Non-Binary")
          return spec([
            ["Non-Binary", "Nonbinary", "Non-binary", "Genderqueer/Non-Binary"],
            declineWords,
          ]);
        return undisclosed(value) ? decline() : null;
      }
      if (topic === "race") {
        const value = employment.ethnicity;
        // A combined race/ethnicity list gives the confirmed Hispanic category
        // precedence. A separate race list must retain the independently known
        // race when that category is absent; Hispanic identity does not erase it.
        const tiers =
          employment.hispanicOrLatino === true
            ? [raceWords["Hispanic or Latino"]]
            : [];
        if (undisclosed(value)) tiers.push(declineWords);
        else if (typeof value === "string" && value.trim())
          tiers.push(raceWords[value] || [value]);
        return tiers.length ? spec(tiers) : null;
      }
      if (topic === "hispanic") {
        // Race alone cannot establish non-Hispanic identity (e.g. Asian Latino).
        const value =
          employment.hispanicOrLatino === undefined
            ? undisclosed(employment.ethnicity)
              ? "undisclosed"
              : employment.ethnicity === "Hispanic or Latino"
                ? true
                : null
            : employment.hispanicOrLatino;
        if (value === true)
          return spec([["Yes", "Hispanic or Latino", "Hispanic / Latino"]]);
        if (value === false)
          return spec([
            ["No", "Not Hispanic or Latino", "Not Hispanic/Latino"],
          ]);
        return undisclosed(value) ? decline() : null;
      }
      if (topic === "disability") {
        const value = employment.disability;
        if (value === true)
          return spec([
            [
              "Yes",
              "Yes, I have a disability",
              "Yes, I have a disability (or previously had a disability)",
              "Yes, I have a disability, or have had one in the past",
            ],
          ]);
        if (value === false)
          return spec([
            [
              "No",
              "No, I do not have a disability",
              "No, I do not have a disability and have not had one in the past",
              "No, I don't have a disability",
            ],
          ]);
        return undisclosed(value) ? decline() : null;
      }
      if (topic === "veteran" || topic === "protected_veteran") {
        const value = employment.veteran;
        // "Not a veteran" is exact wording only: "No" alone may belong to a
        // protected-veteran question with a different meaning.
        if (value === false)
          return spec([
            [
              "No",
              "I am not a veteran",
              "I do not identify as a veteran",
              "I am not a protected veteran",
            ],
          ]);
        if (value === true && topic === "veteran" && context.knownQuestion)
          return spec([["Yes", "I am a veteran", "I identify as a veteran"]]);
        return undisclosed(value) ? decline() : null;
      }
      return null;
    }
    const degreeCandidates = (value) =>
      String(value ?? "").trim() ? [...new Set(degreeTiers(value).flat())] : [];
    const literalSpec = (topic, value) =>
      typeof value === "string" && value.trim()
        ? { topic, tiers: [[value.trim()]], answer: value.trim() }
        : null;
    function websiteTypeSpec(url, websites = {}) {
      if (typeof url !== "string" || !url.trim()) return null;
      const type =
        url === websites.personal
          ? "portfolio"
          : url === websites.linkedin
            ? "linkedin"
            : "other";
      return literalSpec("website_type", type);
    }
    // Search terms for a school catalog. Catalogs search literal substrings and
    // may spell the name differently ("University of California - Berkeley"):
    // the full name first, then its campus, then its most specific word. A term
    // only retrieves candidates; the complete name owns the match.
    function schoolQueries(name) {
      const full = name.replace(/\s+/g, " ").trim(),
        tail = full
          .split(/[,–—-]/)
          .at(-1)
          .trim();
      const generic =
        /^(?:university|college|institute|school|state|community|technology|technical|polytechnic|academy|of|the|at|and|in|for)$/i;
      const keyword = full
        .split(/[,\s–—-]+/)
        .filter((word) => word.length >= 4 && !generic.test(word))
        .sort((a, b) => b.length - a.length)[0];
      return [
        ...new Set([
          full,
          ...(tail.length >= 3 && tail !== full ? [tail] : []),
          ...(keyword ? [keyword] : []),
        ]),
      ];
    }
    const schoolSpec = (value) => {
      const spec = literalSpec("school", value),
        text = schoolIdentity(value).text;
      return spec
        ? {
            ...spec,
            query: text,
            queries: schoolQueries(text),
            equals: schoolMatches,
          }
        : null;
    };
    function fieldOfStudySpec(value) {
      const spec = literalSpec("education_fieldOfStudy", value);
      // A general catalog label is equivalent; specialist disciplines are not.
      return spec && normalize(value) === "physics"
        ? { ...spec, tiers: [...spec.tiers, ["Physics, General"]] }
        : spec;
    }
    function knownSpec(question, value, context = {}) {
      const rule = classify(question);
      if (["city", "postalCode"].includes(context.geography?.kind)) {
        const spec = literalSpec("geography", value),
          facts = context.geography;
        if (!spec) return null;
        const key = (text) =>
          String(text ?? "")
            .normalize("NFKC")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();
        return {
          ...spec,
          query: value,
          equals: (label, answer) => {
            if (key(label) === key(answer)) return true;
            const parts = String(label)
              .split(",")
              .map((part) => part.trim());
            if (parts.length < 2 || key(parts[0]) !== key(answer)) return false;
            if (!facts.state || key(parts.at(-1)) !== key(facts.state))
              return false;
            if (facts.kind === "postalCode")
              return (
                parts.length === 3 &&
                !!facts.city &&
                key(parts[1]) === key(facts.city)
              );
            return parts.length === 2;
          },
        };
      }
      if (rule?.educationField === "school") return schoolSpec(value);
      if (rule?.educationField === "fieldOfStudy")
        return fieldOfStudySpec(value);
      if (rule?.educationField === "degree" || rule?.kind === "degree")
        return degreeSpec(value);
      if (rule?.field === "addressData.country") return countrySpec(value);
      if (rule?.field === "addressData.state")
        return regionSpec(value, context.country);
      if (rule?.field === "contactData.phoneDeviceType")
        return phoneTypeSpec(value);
      if (rule?.kind === "skills") return skillSpec(value);
      return literalSpec(rule?.topic || "known-answer", value);
    }
    function skillSpec(value) {
      const spec = literalSpec("skill", value);
      if (!spec) return null;
      // These suffixes describe the same named programming language. Exact
      // names win; never use substring matching (Java must not select JavaScript).
      if (
        /^(?:python|java|javascript|typescript|c|c\+\+|c#|go|rust|ruby|php|swift|kotlin|scala|r|sql|bash|perl|matlab|julia|dart)$/i.test(
          value,
        )
      )
        spec.tiers.push([value + " Programming", value + " Scripting"]);
      return { ...spec, append: true };
    }
    function locationSpec(address = {}) {
      // Employment locations may be stored as "City, State". Compare the
      // supplied parts against a unique catalog place; never borrow home-country facts.
      if (typeof address === "string") {
        const supplied = address.split(",").map((part) => part.trim());
        const spec = literalSpec("location", address);
        if (
          !spec ||
          ![2, 3].includes(supplied.length) ||
          supplied.some((part) => !part)
        )
          return spec;
        return {
          ...spec,
          queries: [address, supplied[0]],
          equals: (label) => {
            if (normalize(label) === normalize(address)) return true;
            const parts = String(label)
              .split(",")
              .map((part) => part.trim());
            return (
              parts.length === 3 &&
              normalize(parts[0]) === normalize(supplied[0]) &&
              !!JobsOptionMatch.pick(
                [parts[1]],
                regionSpec(supplied[1], supplied[2] || parts[2]),
              ) &&
              (!supplied[2] ||
                !!JobsOptionMatch.pick([parts[2]], countrySpec(supplied[2])))
            );
          },
        };
      }
      if (
        ![address.city, address.state, address.country].every(
          (value) => typeof value === "string" && value.trim(),
        )
      )
        return null;
      const answer = [address.city, address.state, address.country].join(", ");
      const region = regionSpec(address.state, address.country),
        nation = countrySpec(address.country);
      // A place search tries "City, State", then the city alone.
      return {
        topic: "location",
        answer,
        query: [address.city, address.state].join(", "),
        queries: [[address.city, address.state].join(", "), address.city],
        address: {
          city: address.city,
          state: address.state,
          country: address.country,
        },
        tiers: [[answer]],
        equals: (label) => {
          const parts = String(label)
            .split(",")
            .map((part) => part.trim());
          return (
            parts.length === 3 &&
            normalize(parts[0]) === normalize(address.city) &&
            !!JobsOptionMatch.pick([parts[1]], region) &&
            !!JobsOptionMatch.pick([parts[2]], nation)
          );
        },
      };
    }
    function datePartSpec(value, part) {
      const match = String(value || "").match(
        /^(\d{4})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/,
      );
      if (!match) return null;
      const [, year, month, day] = match;
      if (
        day &&
        Number(day) >
          new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
      )
        return null;
      const aliases =
        part === "year"
          ? [year]
          : part === "month"
            ? [
                months[Number(month) - 1],
                months[Number(month) - 1].slice(0, 3),
                month,
                String(Number(month)),
              ]
            : part === "day" && day
              ? [day, String(Number(day))]
              : [];
      return aliases.length
        ? { topic: "date:" + part, tiers: [aliases], answer: aliases[0] }
        : null;
    }
    // Phone country pickers label each country with its dialing code
    // ("United States +1"); the code is not part of the country's name.
    const dialingCode = /\s*\(?\+\d{1,4}\)?\s*$/;
    function countrySpec(value) {
      const result = literalSpec("country", value);
      if (!result) return null;
      const loose = JobsOptionMatch?.loose || normalize;
      result.equals = (label, alias) =>
        loose(String(label).replace(dialingCode, "")) === loose(alias);
      const known = countryCatalog.find(
        ([code]) => code === country(value, { exact: true }),
      );
      if (known) {
        result.tiers = [
          [value.trim(), known[0], ...known[1], ...(known[2] || [])],
        ];
        result.query = known[0] === "US" ? "United States" : known[1][0];
      }
      return result;
    }
    const canadianRegions = Object.fromEntries(
      "AB:Alberta|BC:British Columbia|MB:Manitoba|NB:New Brunswick|NL:Newfoundland and Labrador|NS:Nova Scotia|NT:Northwest Territories|NU:Nunavut|ON:Ontario|PE:Prince Edward Island|QC:Quebec|SK:Saskatchewan|YT:Yukon"
        .split("|")
        .map((item) => item.split(":")),
    );
    function regionSpec(value, countryValue) {
      const result = literalSpec("region", value);
      if (!result) return null;
      const code = country(countryValue, { exact: true }),
        regions =
          code === "US" ? usStates : code === "CA" ? canadianRegions : {};
      const pair = Object.entries(regions).find((pair) =>
        pair.some((alias) => normalize(alias) === normalize(value)),
      );
      if (pair) {
        result.tiers = [[value.trim(), ...pair]];
        result.query = pair[1];
      }
      return result;
    }
    // Filling defaults for facts the Profile does not hold yet. A Profile value
    // always wins; these can later become Profile settings.
    const defaults = Object.freeze({
      phoneDeviceType: "Mobile",
      recruitingSource: [
        "LinkedIn",
        "Job Board/Online",
        "Company Website/Careers",
        "Other",
      ],
    });
    function phoneTypeSpec(value) {
      value = String(value ?? "").trim() || defaults.phoneDeviceType;
      const result = literalSpec("phone_type", value);
      if (!result) return null;
      const aliases = [
        ["Mobile", "Cell", "Cellular", "Cell Phone", "Mobile Phone"],
        ["Home", "Home Phone"],
        ["Work", "Business", "Work Phone"],
        ["Main", "Primary"],
        ["Other"],
      ].find((group) =>
        group.some((alias) => normalize(alias) === normalize(value)),
      );
      if (aliases) result.tiers = [aliases];
      return result;
    }
    /** @param {string} value @param {{fluent?:boolean}} [options] */
    function languageSpec(value, { fluent } = {}) {
      const result = literalSpec("language_proficiency", value);
      if (!result) return null;
      const groups = [
        ["Beginner", "Basic", "Elementary", "Elementary Proficiency"],
        ["Intermediate", "Limited working", "Limited Working Proficiency"],
        [
          "Advanced",
          "Professional working",
          "Professional Working Proficiency",
        ],
        ["Full Professional Proficiency", "Full Professional"],
        [
          "Native",
          "Native or bilingual",
          "Native or Bilingual Proficiency",
          "Native Speaker",
          "Bilingual",
        ],
      ];
      const level = groups.findIndex((group) =>
        group.some((alias) => normalize(alias) === normalize(value)),
      );
      result.tiers = [level >= 0 ? groups[level] : [value.trim()]];
      // A broad fluent/high category is supported by explicit fluency or full
      // professional/native proficiency. It never implies native identity.
      if (level >= 3 || fluent === true || normalize(value) === "fluent")
        result.tiers.push(["Fluent", "High", "Fluent / Native Speaker"]);
      if (level === 3) result.tiers.push(groups[2]);
      return result;
    }
    const sourceCategories = {
      linkedin: ["LinkedIn", "LinkedIn Jobs"],
      online: [
        "Job Board/Online",
        "Job Board / Online",
        "Job Board",
        "Online Job Board",
        "Online",
        "Internet",
        "Job Boards",
        "Online Job Posting",
      ],
      website: [
        "Company Website/Careers",
        "Company Website / Careers",
        "Company Website",
        "Company Careers Site",
        "Company Careers Page",
        "Careers Website",
        "Careers Site",
        "Career Site",
        "Website",
        "Corporate Website",
        "Our Website",
      ],
      other: ["Other"],
    };
    // Some sites group sources as "Category - Source" (RTX: "Job Board - LinkedIn").
    // The source is the last segment; a label matches its whole text or that segment,
    // and two equally matching labels still stop as ambiguous.
    const sourceLeaf = (label) =>
      String(label ?? "")
        .split(/\s+[-\u2013\u2014>|/]\s+|:\s+/)
        .pop()
        .trim();
    const sourceEquals = (label, alias) => {
      const loose = JobsOptionMatch.loose;
      return (
        loose(label) === loose(alias) ||
        loose(sourceLeaf(label)) === loose(alias)
      );
    };
    function recruitingSourceSpec(profile, context = {}) {
      const key = (value) =>
        Object.keys(sourceCategories).find((key) =>
          sourceCategories[key].some(
            (alias) => normalize(alias) === normalize(value),
          ),
        );
      // Actual per-application context outranks a default preference. Do not
      // interpret a past application's captured source as a new discovery fact.
      const actual = context.recruitingSource;
      if (typeof actual === "string" && actual.trim())
        return {
          topic: "recruiting_source",
          tiers: [sourceCategories[key(actual)] || [actual.trim()]],
          answer: actual.trim(),
          origin: "application",
          equals: sourceEquals,
        };
      // This is the existing owner-authored Profile preference block, not a
      // global LinkedIn default. Unrecognized prose remains available to AI.
      // The Profile preference block when present, otherwise the filling default.
      const notes = String(profile?.applicationData?.aiNotes || "").replace(
        /\\n/g,
        "\n",
      );
      const block = notes.match(
        /(?:^|\n)Recruiting-source preference:\s*([^\n]+)/i,
      )?.[1];
      const list = block?.match(
        /^(?:For ordinary .+? I authorize an automatic default without asking me to confirm:\s*)?prefer ([^.]+)\./i,
      )?.[1];
      const values = list
        ? list
            .split(/\s*→\s*|,\s*(?:then\s+)?/i)
            .map((value) => value.trim().replace(/^then\s+/i, ""))
        : defaults.recruitingSource;
      const keys = values.map(key);
      if (
        !keys.length ||
        keys.some((key) => !key) ||
        new Set(keys).size !== keys.length
      )
        return null;
      const ordinary = (label) =>
        /^(?:indeed|glassdoor|ziprecruiter|builtin|built in|google jobs|google search|internet search|online advertising|job (?:search )?website)$/i.test(
          sourceLeaf(label),
        );
      const allowFirst =
        !list ||
        /\bchoose the first available ordinary source category\b/i.test(block);
      // Search prompts (Workday) list categories until searched; each preferred
      // source is searched by its plain name.
      const queries = keys.map(
        (key) =>
          ({
            linkedin: "LinkedIn",
            online: "Job Board",
            website: "Website",
            other: "Other",
          })[key],
      );
      return {
        topic: "recruiting_source",
        tiers: keys.map((key) => sourceCategories[key]),
        answer: values[0],
        query: "",
        queries,
        origin: list ? "profile_preference" : "default",
        equals: sourceEquals,
        ...(allowFirst
          ? { fallback: "first-authorized", acceptFallback: ordinary }
          : {}),
      };
    }
    function selectDegree(value, labels) {
      if (!String(value ?? "").trim()) return null;
      if (!labels?.length) return value;
      return JobsOptionMatch.pick(labels, degreeSpec(value))?.label ?? null;
    }
    // Catalogs can append a US state to a school name. Keep campus qualifiers
    // intact and reject conflicting explicit regions; never match a keyword alone.
    function schoolIdentity(value) {
      const text = String(value ?? "")
        .normalize("NFKC")
        .trim();
      const suffix = text.match(
        /\s+\((AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\)$/i,
      );
      const name = suffix ? text.slice(0, suffix.index).trim() : text;
      return {
        text: name,
        name: normalize(name)
          .replace(/[,–—-]/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
        region: suffix?.[1].toUpperCase() || "",
      };
    }
    function schoolMatches(label, answer) {
      const candidate = schoolIdentity(label),
        expected = schoolIdentity(answer);
      // Preserve the public identity used by search; aliases affect equivalence
      // only, after punctuation normalization, and never discard the campus.
      const canonical = (name) => {
        // "University of California at Berkeley" is the same campus name.
        const alias = (value) =>
          value
            .replace(/ at /g, " ")
            .replace(/^university of california /, "uc ");
        const suffix = name.match(/^(.*?)\s+\(([^()]*)\)$/);
        // Remove only a redundant alias, not a campus, school or program suffix.
        return suffix && alias(suffix[1]) === alias(suffix[2])
          ? alias(suffix[1])
          : alias(name);
      };
      return (
        !!expected.name &&
        canonical(candidate.name) === canonical(expected.name) &&
        (!candidate.region ||
          !expected.region ||
          candidate.region === expected.region)
      );
    }
    // Country facts, question scope and option selection share this catalog.
    // Codes that are ordinary lowercase words (us/in/it) only match standalone
    // values or scoped locations; the established uppercase US alias is retained.
    /** @type {Array<[string,string[],string[]?]>} */
    const countryCatalog = [
      [
        "US",
        [
          "united states of america",
          "united states",
          "usa",
          "u.s.a.",
          "u.s.a",
          "u.s.",
          "u.s",
        ],
      ],
      ["CA", ["canada"]],
      ["UK", ["united kingdom", "great britain", "uk", "u.k.", "u.k"], ["gb"]],
      ["FR", ["france"]],
      ["DE", ["germany"]],
      ["AU", ["australia"]],
      ["IN", ["india"]],
      ["CN", ["china"]],
      ["JP", ["japan"]],
      ["SG", ["singapore"]],
      ["IE", ["ireland"]],
      ["NL", ["netherlands"]],
      ["MX", ["mexico"]],
      ["BR", ["brazil"]],
      ["KR", ["south korea"]],
      ["NZ", ["new zealand"]],
      ["ES", ["spain"]],
      ["IT", ["italy"]],
      ["CH", ["switzerland"]],
    ];
    function country(value, { exact = false } = {}) {
      const text = normalize(value),
        literal = text.replace(/[.]+$/, "");
      const matches = countryCatalog
        .filter(([code, names, aliases = []]) => {
          if (
            [code, ...names, ...aliases].some(
              (name) => normalize(name).replace(/[.]+$/, "") === literal,
            )
          )
            return true;
          if (exact) return false;
          if (code === "US" && /\bUS\b/.test(String(value))) return true;
          return names.some((name) =>
            new RegExp(
              "(?:^|\\W)" +
                name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
                "(?=$|\\W)",
            ).test(text),
          );
        })
        .map(([code]) => code);
      return matches.length > 1 ? "MIXED" : matches[0] || null;
    }
    // Each theme owns recognition, fact paths, answer specifications and saved-answer policy.
    // Priorities retain the tested precedence of direct wording over broad topic guards.
    const topicRegistry = Object.freeze({
      consent: Object.freeze({
        facts: [],
        strictness: "explicit-authorization",
        optionSpec: answerSpec,
        resolve: resolveConsent,
        saved: consentSaved,
        recognize: [{ priority: -20, match: consentMatch }],
      }),
      legal_history: Object.freeze({
        facts: [],
        strictness: "exact-question",
        optionSpec: answerSpec,
        resolve: () => null,
        saved: () => ({ exactOnly: true }),
        recognize: [
          {
            priority: 10000,
            match(question) {
              return /\b(?:citizenship|citizen|nationality|lawful permanent resident|intellectual property)\b/i.test(
                question,
              ) ||
                (/\b(?:government|department of defense|dod|military)\b/i.test(
                  question,
                ) &&
                  /\b(?:employee|employed|employment)\b/i.test(question))
                ? { topic: "legal_history", managed: false }
                : null;
            },
          },
        ],
      }),
      education: Object.freeze({
        answers: [
          "educationType",
          "extended",
          "exact",
          "graduated",
          "education",
          "graduation",
        ],
        extended: (rule) => (rule.personal ? "personal" : "education"),
        facts: ["educationData", "applicationData.highestCompletedEducation"],
        strictness: "exact-fact",
        resolve: resolveProfileRule,
        optionSpec: answerSpec,
        saved: ordinarySaved,
        recognize: [
          {
            priority: 0,
            additional: false,
            match(question, context) {
              const q = normalize(question).replace(/[\s*✱]+$/g, "");
              if (/^(?:school|education|institution) type[?:.]?$/.test(q))
                return {
                  topic: "education_type",
                  field: "educationData.schoolType",
                  kind: "education-type",
                };
              return null;
            },
          },
          {
            priority: 6,
            additional: false,
            match(question, context) {
              const q = normalize(question).replace(/[\s*✱]+$/g, "");
              if (/^(?:graduated|have you graduated)[?.]?$/.test(q))
                return {
                  topic: "graduated",
                  field: "educationData.endDate",
                  kind: "graduated",
                };
              return null;
            },
          },
          {
            priority: 7,
            additional: false,
            match(question, context) {
              const q = normalize(question).replace(/[\s*✱]+$/g, "");
              if (
                /^(?:what term did you \(or will you\) graduate in|what is your expected graduation timeline)[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "graduation",
                  field: "educationData.endDate",
                  kind: "month-year",
                  termOptionsOnly: true,
                };
              return null;
            },
          },
          {
            priority: 8,
            additional: false,
            match(question, context) {
              const q = normalize(question).replace(/[\s*✱]+$/g, "");
              if (/\bgraduat(?:e|ed|ing|ion)\b|degree completion/.test(q)) {
                if (
                  /\b(?:high school|secondary|master|ph\.?d|doctor|spring|summer|fall|autumn|winter|term|timeline|push|delay|extend|before|after|between|within|range|eligible|attending|university of|georgia tech)\b/.test(
                    q,
                  ) ||
                  (/\b(?:are|have|did|will|can|do) you\b/.test(q) &&
                    !/\b(?:when|what|which)\b/.test(q)) ||
                  /\b(?:19|20)\d{2}\b/.test(q)
                )
                  return { topic: "graduation_condition", managed: false };
                const direct =
                  /\b(?:when|what|which|expected|anticipated|estimated|graduation date|graduation year|graduation month|degree completion)\b/.test(
                    q,
                  );
                if (
                  direct &&
                  q.length < 240 &&
                  !/\b(?:government|employment history|experience|gpa|school name)\b/.test(
                    q,
                  )
                ) {
                  const month = /\bmonth\b/.test(q),
                    year = /\byear\b/.test(q);
                  const day = /\bday\b|\bdd\b/.test(q);
                  return {
                    topic: "graduation",
                    field: "educationData.endDate",
                    kind: day
                      ? "exact-date"
                      : month && !year
                        ? "month"
                        : year && !month
                          ? "year"
                          : "month-year",
                  };
                }
                return { topic: "graduation_other", managed: false };
              }
              return null;
            },
          },
          {
            priority: 9,
            additional: false,
            match(question, context) {
              const q = normalize(question).replace(/[\s*✱]+$/g, "");
              const education = /** @type {Array<[string,RegExp]>} */ ([
                [
                  "school",
                  /^(?:please select your school from the list|name of (?:your )?(?:school|college|university)|(?:school|college|university)(?: name)?|(?:what|which) (?:school|college|university) (?:(?:do|did) you (?:currently )?attend|are you (?:currently )?attending)|what is the name of the school or institution you currently attend or most recently attended)[?:.]?$/,
                ],
                [
                  "fieldOfStudy",
                  /^(?:undergrad(?:uate)? disciplines?(?:\(s\))?|please select your major from the list|(?:school |college |university )?major|(?:primary )?field of study|what is(?:\/was)? your (?:major(?: or field of study)?|field of study)|please indicate your program major|what major \/ area of study are you pursuing)[?:.]?$/,
                ],
                [
                  "degree",
                  /^(?:education level|degree(?: type)?|what degree are you (?:currently )?pursuing|what is your current degree program)[?:.]?$/,
                ],
                [
                  "gpa",
                  /^(?:cumulative gpa|undergraduate gpa|gpa|what is(?:\/was)? your (?:cumulative )?gpa|please indicate your most recent gpa|similarly, we also invite you to provide your gpa, this can help us further understand your academic experience)(?: and the scale your school uses \([^)]*\))?[?:.]?$/,
                ],
              ]).find(([, pattern]) => pattern.test(q));
              if (education)
                return {
                  topic: "education_" + education[0],
                  field: "educationData." + education[0],
                  educationField: education[0],
                  kind: education[0] === "gpa" ? "gpa" : "text",
                };
              return null;
            },
          },
          {
            priority: 16,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:what|which) (?:degree|degree program) are you (?:currently )?enrolled in[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "education_degree",
                  field: "educationData.degree",
                  educationField: "degree",
                  kind: "text",
                  currentEducationOnly: true,
                };
              return null;
            },
          },
          {
            priority: 18,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:are you in school|are you currently enrolled in a degree[- ]seeking program)[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "education_attending",
                  field: "educationData.currentlyAttending",
                  educationField: "currentlyAttending",
                  kind: "education-boolean",
                };
              return null;
            },
          },
          {
            priority: 19,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (/^start date at (?:your )?current school[?.:]?$/.test(q))
                return {
                  topic: "education_start",
                  field: "educationData.startDate",
                  kind: "month-year",
                };
              return null;
            },
          },
          {
            priority: 20,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^please re[- ]confirm the university you currently attend[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "education_school",
                  field: "educationData.school",
                  educationField: "school",
                  kind: "text",
                };
              return null;
            },
          },
          {
            priority: 21,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:what is the highest level of education you are pursuing or have completed|what degree level are you currently pursuing, or have you most recently completed|please confirm your highest level of study\. \(this should be either your current study level or the most recently completed one, if you recently completed\.\))[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "education_degree",
                  field: "educationData.degree",
                  educationField: "degree",
                  kind: "text",
                };
              return null;
            },
          },
          {
            priority: 22,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^for your current \/ most recent education please provide result scale[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "education_gpa_scale",
                  field: "educationData.gpa",
                  kind: "gpa-scale",
                };
              return null;
            },
          },
          {
            priority: 23,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^what is your current overall gpa \(please convert to 4\.0 scale\)\s*[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "education_gpa",
                  field: "educationData.gpa",
                  educationField: "gpa",
                  kind: "gpa",
                  requiredScale: 4,
                };
              return null;
            },
          },
          {
            priority: 24,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^if you are currently enrolled in a degree program \(bs, ms or phd\) or have just completed one, please indicate your gpa[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "education_gpa",
                  field: "educationData.gpa",
                  educationField: "gpa",
                  kind: "gpa",
                };
              return null;
            },
          },
          {
            priority: 31,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:please confirm the highest level of education that you have completed|please indicate the highest level of education you have completed|what is your highest level of education achieved)[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "completed_education",
                  field: "applicationData.highestCompletedEducation",
                  kind: "degree",
                  personal: true,
                };
              return null;
            },
          },
          {
            priority: 36,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:what(?: is|'s) (?:your |the )?|please (?:provide|select|indicate) your )?(?:highest (?:level of )?(?:completed|attained) (?:education|degree)|highest (?:degree|level of education|education level) (?:(?:you have )?(?:completed|attained|earned))|highest educational qualification)[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "completed_education",
                  field: "applicationData.highestCompletedEducation",
                  kind: "degree",
                  personal: true,
                };
              return null;
            },
          },
          {
            priority: 50,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:are you (?:currently )?(?:enrolled|attending|studying)(?: (?:in|at) (?:a |an )?(?:college|university|school|degree program))?|are you (?:currently )?a student|current(?:ly)? student|still student)[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "education_attending",
                  field: "educationData.currentlyAttending",
                  educationField: "currentlyAttending",
                  kind: "education-boolean",
                };
              return null;
            },
          },
          {
            priority: 58,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (/^education end (?:month|year)[?.:]?$/.test(q))
                return {
                  topic: "graduation",
                  field: "educationData.endDate",
                  kind: /\bmonth\b/.test(q) ? "month" : "year",
                };
              if (
                /^(?:(?:education|school|college|university) (?:start|starting|enrollment) (?:date|month|year)|(?:what (?:is|was) your |please (?:provide|indicate) your )?(?:enrollment|matriculation) (?:date|month|year)|when did you (?:start|begin) (?:college|university|school))(?:\s*\([^)]*\))?[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "education_start",
                  field: "educationData.startDate",
                  kind: /\bday\b|\bdd\b/.test(q)
                    ? "exact-date"
                    : /\bmonth\b/.test(q) && !/\byear\b/.test(q)
                      ? "month"
                      : /\byear\b/.test(q) && !/\bmonth\b/.test(q)
                        ? "year"
                        : "month-year",
                };
              return null;
            },
          },
          {
            priority: 59,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              const education = /** @type {Array<[string,RegExp]>} */ ([
                [
                  "school",
                  /^(?:please select your school from the list|name of (?:your )?(?:school|college|university)|(?:current )?(?:school|college|university)(?: name)?|(?:what|which) (?:school|college|university) (?:(?:do|did) you (?:currently )?attend|are you (?:currently )?attending)|what is the name of the school or institution you currently attend or most recently attended)[?:.]?$/,
                ],
                [
                  "fieldOfStudy",
                  /^(?:undergrad(?:uate)? disciplines?(?:\(s\))?|please select your major from the list|(?:school |college |university )?major(?:\(s\))?|(?:primary )?field of study|what is(?:\/was)? your (?:major(?: or field of study)?|field of study)|please indicate your program major|what major \/ area of study are you pursuing)[?:.]?$/,
                ],
                [
                  "degree",
                  /^(?:education level|degree(?: type)?|current or most recent degree|what degree are you (?:currently )?pursuing|what is your current degree program)[?:.]?$/,
                ],
                [
                  "gpa",
                  /^(?:cumulative gpa|undergraduate gpa|gpa|what is(?:\/was)? your (?:cumulative )?gpa|please indicate your most recent gpa|similarly, we also invite you to provide your gpa, this can help us further understand your academic experience)(?: and the scale your school uses \([^)]*\))?[?:.]?$/,
                ],
              ]).find(([, pattern]) => pattern.test(q));
              if (education)
                return {
                  topic: "education_" + education[0],
                  field: "educationData." + education[0],
                  educationField: education[0],
                  kind: education[0] === "gpa" ? "gpa" : "text",
                };
              return null;
            },
          },
        ],
      }),
      recruiting_source: Object.freeze({
        answers: ["source"],
        extended: () => null,
        facts: ["applicationData.aiNotes"],
        strictness: "exact-fact",
        resolve: resolveProfileRule,
        optionSpec: answerSpec,
        saved: ordinarySaved,
        recognize: [
          {
            priority: 1,
            additional: false,
            match(question, context) {
              const q = normalize(question).replace(/[\s*✱]+$/g, "");
              if (
                /^(?:how did you (?:hear|learn) about (?:us|this (?:job|role|position|opportunity)|our company)|where did you (?:hear about|find|see) (?:us|this (?:job|role|position|opportunity))|(?:application|applicant|candidate|recruiting|referral) source|source)[?:.]?$/.test(
                  q,
                )
              )
                return {
                  topic: "recruiting_source",
                  field: "applicationData.aiNotes",
                  kind: "source",
                };
              return null;
            },
          },
        ],
      }),
      identity: Object.freeze({
        answers: ["signature", "catalog", "eeo", "extended", "personal"],
        extended: () => "personal",
        facts: ["nameData", "addressData", "contactData", "websiteData"],
        strictness: "exact-fact",
        resolve: resolveProfileRule,
        optionSpec: answerSpec,
        saved: ordinarySaved,
        recognize: [
          {
            priority: 2,
            additional: false,
            match(question, context) {
              const q = normalize(question).replace(/[\s*✱]+$/g, "");
              if (
                /^(?:street )?address\s*(?:line\s*)?(?:2|two)(?:\s*\(optional\))?[?:.]?$/.test(
                  q,
                )
              )
                return {
                  topic: "address",
                  field: "addressData.line2",
                  kind: "text",
                  personal: true,
                  profileOnly: true,
                };
              return null;
            },
          },
          {
            priority: 5,
            additional: false,
            match(question, context) {
              const q = normalize(question).replace(/[\s*✱]+$/g, "");
              const personal = /** @type {Array<[string,string,RegExp]>} */ ([
                [
                  "name",
                  "nameData.fullName",
                  /^(?:legal name|full (?:legal )?name|your full name|what is your (?:full |legal )?name)[?:.]?$/,
                ],
                [
                  "contact",
                  "contactData.email",
                  /^(?:e-?mail(?: address)?|what is your email address)[?:.]?$/,
                ],
                [
                  "contact",
                  "contactData.phoneNumber",
                  /^(?:phone(?: number)?|mobile(?: phone)? number)[?:.]?$/,
                ],
                [
                  "address",
                  "addressData.line1",
                  /^(?:street address|address line ?1)[?:.]?$/,
                ],
                [
                  "address",
                  "addressData.city",
                  /^(?:city|current city|city of residence)[?:.]?$/,
                ],
                [
                  "address",
                  "addressData.postalCode",
                  /^(?:zip(?: code)?|postal code|zip \/ postal code|what is the zip code of your primary residence)[?:.]?$/,
                ],
                [
                  "address",
                  "addressData.country",
                  /^(?:what country do you currently reside in|country of residence)[?:.]?$/,
                ],
                [
                  "links",
                  "websiteData.github",
                  /^(?:github(?: (?:url|link|profile))?|if applicable, please provide a link to relevant work samples \(e\.g\. github, codepen, dribbble, behance, etc\.\))[?:.]?$/,
                ],
                [
                  "links",
                  "websiteData.linkedin",
                  /^(?:linkedin(?: (?:url|link|profile))?)[?:.]?$/,
                ],
              ]).find(([, , pattern]) => pattern.test(q));
              if (personal)
                return {
                  topic: personal[0],
                  field: personal[1],
                  kind: "text",
                  personal: true,
                };
              return null;
            },
          },
          {
            priority: 12,
            additional: false,
            match(question, context) {
              const q = normalize(question).replace(/[\s*✱]+$/g, "");
              if (
                /^relocation assistance may be available for this role\. if you would need to relocate, please tell us the city, state, and zip code you'd be moving from[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "address",
                  field: "addressData.location",
                  kind: "text",
                  personal: true,
                  includePostalCode: true,
                  additional: true,
                };
              return null;
            },
          },
          {
            priority: 17,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:what is your current location|where are you based)[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "address",
                  field: "addressData.location",
                  kind: "text",
                  personal: true,
                };
              return null;
            },
          },
          {
            priority: 30,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:please confirm your visa type|please indicate your current us employment visa status)[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "visa_status",
                  field: "applicationData.visaStatus",
                  kind: "text",
                  personal: true,
                };
              return null;
            },
          },
          {
            priority: 34,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:(?:what (?:is|are)|please (?:provide|specify|share|select|indicate)) (?:your )?)?(?:preferred )?(?:gender )?pronouns(?: do you use)?[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "pronouns",
                  field: "applicationData.pronouns",
                  kind: "text",
                  personal: true,
                };
              return null;
            },
          },
          {
            priority: 37,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:what is your |please (?:specify|provide|select) your )?(?:current )?(?:visa(?: \/ immigration)? (?:type|status)|immigration status|immigration \/ visa status)[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "visa_status",
                  field: "applicationData.visaStatus",
                  kind: "text",
                  personal: true,
                };
              return null;
            },
          },
          {
            priority: 45,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              const personal = /** @type {Array<[string,string,RegExp]>} */ ([
                [
                  "name",
                  "nameData.fullName",
                  /^(?:legal name|full (?:legal )?name|your full name|what is your (?:full |legal )?name|please (?:enter|provide) your full (?:legal )?name(?:,? as (?:it )?appears (?:on|in) [^?]{1,80})?)[?:.]?$/,
                ],
                [
                  "name",
                  "nameData.fullName",
                  /^(?:signature|electronic signature|type (?:your )?full name (?:to sign|as (?:your )?(?:electronic )?signature))[?:.]?$/,
                ],
                [
                  "name",
                  "nameData.firstName",
                  /^(?:first name|given name|legal first name|first \(given\) name)[?:.]?$/,
                ],
                [
                  "name",
                  "nameData.middleName",
                  /^(?:middle name|legal middle name)[?:.]?$/,
                ],
                [
                  "name",
                  "nameData.lastName",
                  /^(?:last name|family name|surname|legal last name|last \(family\) name)[?:.]?$/,
                ],
                [
                  "name",
                  "nameData.preferredFirstName",
                  /^(?:preferred first name|preferred given name)[?:.]?$/,
                ],
                [
                  "name",
                  "nameData.preferredLastName",
                  /^(?:preferred last name|preferred family name)[?:.]?$/,
                ],
                [
                  "name",
                  "nameData.preferredFullName",
                  /^(?:preferred name|preferred full name|what is your preferred name)[?:.]?$/,
                ],
                [
                  "contact",
                  "contactData.email",
                  /^(?:e-?mail(?: address)?|what is your email address)[?:.]?$/,
                ],
                [
                  "contact",
                  "contactData.phoneNumber",
                  /^(?:phone(?: number)?|mobile(?: phone)? number)[?:.]?$/,
                ],
                [
                  "contact",
                  "contactData.phoneDeviceType",
                  /^(?:phone (?:device )?type|telephone type)[?:.]?$/,
                ],
                [
                  "contact",
                  "contactData.phoneCountryCode",
                  /^(?:phone country code|telephone country code|dial(?:ing)? code)[?:.]?$/,
                ],
                [
                  "address",
                  "addressData.line1",
                  /^(?:street address|address line ?1)[?:.]?$/,
                ],
                [
                  "address",
                  "addressData.fullAddress",
                  /^(?:current |your |full |current full )?(?:mailing |home |residential )?address[?:.]?$/,
                ],
                [
                  "address",
                  "addressData.city",
                  /^(?:city|current city|city of residence)[?:.]?$/,
                ],
                [
                  "address",
                  "addressData.state",
                  /^(?:state|province|state\s*\/\s*province|state or province|state of residence)[?:.]?$/,
                ],
                [
                  "address",
                  "addressData.location",
                  /^(?:current location|your location|location \(city\)|where are you (?:currently )?located|where do you (?:currently )?(?:live|reside)|current city and state|city(?:,| and) state(?: and country)?)[?:.]?$/,
                ],
                [
                  "address",
                  "addressData.postalCode",
                  /^(?:zip(?: code)?|postal code|zip \/ postal code|what is the zip code of your primary residence)[?:.]?$/,
                ],
                [
                  "address",
                  "addressData.country",
                  /^(?:what country do you currently reside in|country of residence|current country|country)[?:.]?$/,
                ],
                [
                  "links",
                  "websiteData.github",
                  /^(?:(?:please (?:enter|provide|share) (?:a link to )?(?:your )?)?github(?: (?:url|link|profile)(?: url)?)?|if applicable, please provide a link to relevant work samples \(e\.g\. github, codepen, dribbble, behance, etc\.\))[?:.]?$/,
                ],
                [
                  "links",
                  "websiteData.linkedin",
                  /^(?:please (?:enter|provide|share) (?:a link to )?(?:your )?)?linkedin(?: (?:url|link|profile)(?: url)?)?[?:.]?$/,
                ],
                [
                  "links",
                  "websiteData.personal",
                  /^(?:please (?:enter|provide|share) (?:a link to )?(?:your )?)?(?:personal (?:website|portfolio)(?: url)?|portfolio(?: (?:url|link))?|website(?: url)?)[?:.]?$/,
                ],
                [
                  "demographic",
                  "employmentData.gender",
                  /^(?:gender|what is your gender|please (?:select|specify|indicate) your gender)[?:.]?$/,
                ],
                [
                  "demographic",
                  "employmentData.ethnicity",
                  /^(?:ethnicity|race(?: \/ ethnicity| and ethnicity)?|what is your ethnicity|please (?:select|specify|indicate) your (?:race|ethnicity))[?:.]?$/,
                ],
              ]).find(([, , pattern]) => pattern.test(q));
              if (personal)
                return {
                  topic: personal[0],
                  field: personal[1],
                  kind: "text",
                  personal: true,
                };
              return null;
            },
          },
        ],
      }),
      sponsorship: Object.freeze({
        answers: ["extended", "boolean"],
        extended: () => "boolean",
        facts: [
          "applicationData.sponsorshipNow",
          "applicationData.sponsorshipFuture",
          "employmentData.sponsorship",
        ],
        strictness: "qualified",
        resolve: resolveProfileRule,
        optionSpec: answerSpec,
        saved: sponsorshipSaved,
        recognize: [
          {
            priority: 3,
            additional: false,
            match(question, context) {
              const q = normalize(question).replace(/[\s*✱]+$/g, "");
              if (/\b(sponsor(?:ship|ing|ed)?|immigration support)\b/.test(q)) {
                // Do not treat current visa type, existing cases, employer policy or
                // combined authorization/clearance questions as a sponsorship boolean.
                const employment =
                  /^(?:will|does|would) your employment (?:require|need) (?:(?:visa|immigration|employer) )?(?:sponsorship|immigration support)(?: (?:now|currently|in the future|now or in the future))?(?: (?:in|to work in) (?:the )?[a-z. ]+)?[?.:]?$/.test(
                    q,
                  );
                if (
                  (employment || /\b(?:will|do|would) you\b/.test(q)) &&
                  /\b(?:require|need)\b/.test(q) &&
                  !/\b(?:without|not require|not need|type|which|explain|describe|already|currently sponsored|security clearance|legally authorized|eligible to work)\b|\band (?:a |an |be |have |hold |obtain |can |will |are |do |relocation)/.test(
                    q,
                  )
                )
                  return {
                    topic: "sponsorship",
                    field: "employmentData.sponsorship",
                    kind: "boolean",
                  };
                return { topic: "sponsorship_detail", managed: false };
              }
              return null;
            },
          },
        ],
      }),
      work_authorization: Object.freeze({
        answers: ["extended", "boolean"],
        extended: () => "boolean",
        facts: ["employmentData.eligibilityUS", "addressData.country"],
        strictness: "qualified",
        resolve: resolveProfileRule,
        optionSpec: answerSpec,
        saved: legalSaved,
        recognize: [
          {
            priority: 4,
            additional: false,
            match(question, context) {
              const q = normalize(question).replace(/[\s*✱]+$/g, "");
              if (
                /^are you (?:legally )?authori[sz]ed to work in (?:the )?(?:united states(?: of america)?|usa|u\.s\.)[?.]?$/.test(
                  q,
                )
              )
                return {
                  topic: "work_authorization",
                  field: "employmentData.eligibilityUS",
                  kind: "boolean",
                };
              return null;
            },
          },
          {
            priority: 41,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:are you (?:currently )?(?:(?:legally|lawfully) )?(?:authori[sz]ed|eligible|permitted) to work(?: (?:in|within) .+)?|do you (?:currently )?have (?:the )?(?:legal )?(?:right|authorization) to work(?: in .+)?)[?.]?$/.test(
                  q,
                ) &&
                !/\b(?:without|restriction|unrestricted|unlimited|permanent|proof|documentation|citizen|clearance|and|or|but|unless|provided|if)\b/.test(
                  q,
                )
              )
                return {
                  topic: "work_authorization",
                  field: "employmentData.eligibilityUS",
                  kind: "boolean",
                };
              return null;
            },
          },
          {
            priority: 60,
            additional: false,
            match(question, context) {
              const q = normalize(question).replace(/[\s*✱]+$/g, "");
              if (
                /\b(?:authori[sz](?:ed|ation)|eligible|permitted|right) (?:to )?work\b|\bwork authori[sz]ation\b/.test(
                  q,
                )
              )
                return { topic: "work_authorization_detail", managed: false };
              return null;
            },
          },
        ],
      }),
      work_preferences: Object.freeze({
        answers: ["extended"],
        extended: () => "workFact",
        facts: [
          "applicationData.willingToRelocate",
          "applicationData.willingToWorkOnsite",
          "applicationData.willingToTravel",
          "applicationData.hasRelatedPeopleAtWork",
        ],
        strictness: "qualified",
        resolve: resolveProfileRule,
        optionSpec: answerSpec,
        saved: workPreferencesSaved,
        recognize: [
          {
            priority: 10,
            additional: false,
            match(question, context) {
              const q = normalize(question).replace(/[\s*✱]+$/g, "");
              const workFact = classifyWorkFact(q);
              if (workFact) return { ...workFact, additional: true };
              return null;
            },
          },
          {
            priority: 11,
            additional: false,
            match(question, context) {
              const q = normalize(question).replace(/[\s*✱]+$/g, "");
              if (
                /\b(?:relatives?|family members?|familial|related to (?:anyone|someone)|personal relationship)\b/.test(
                  q,
                )
              )
                return { topic: "relatives", managed: false };
              return null;
            },
          },
          {
            priority: 13,
            additional: false,
            match(question, context) {
              const q = normalize(question).replace(/[\s*✱]+$/g, "");
              if (/on.?site|in.?office|relocat|commut|\bhybrid\b/.test(q))
                return { topic: "work_location", managed: false };
              return null;
            },
          },
        ],
      }),
      availability: Object.freeze({
        answers: ["extended"],
        extended: (rule) =>
          rule.topic === "weekly_hours" ? "weekly" : "personal",
        facts: [
          "applicationData.weeklyHours",
          "applicationData.earliestStartDate",
        ],
        strictness: "exact-fact",
        resolve: resolveProfileRule,
        optionSpec: answerSpec,
        saved: ordinarySaved,
        recognize: [
          {
            priority: 14,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:how many (?:working )?hours (?:per|a|each) week (?:are you (?:available|able) to work|can you (?:work|commit(?: to working)?)|would you be available to work)|how many hours (?:are you (?:available|able) to work|can you work) (?:per|a|each) week|(?:available )?(?:working )?hours per week|weekly (?:work )?availability \(hours\)|每周(?:可以|可|能)?工作(?:多少小时|时长))[?.:？：]?$/.test(
                  q,
                )
              )
                return {
                  topic: "weekly_hours",
                  field: "applicationData.weeklyHours",
                  kind: "weekly-hours",
                };
              return null;
            },
          },
          {
            priority: 15,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              const hours = q.match(
                /^(?:are you (?:available|able) to work|can you (?:work|commit to(?: working)?)) (?:at least )?(\d+(?:\.\d+)?) hours (?:per|a|each) week[?.:]?$/,
              );
              if (hours && Number(hours[1]) > 0 && Number(hours[1]) <= 168)
                return {
                  topic: "weekly_hours",
                  field: "applicationData.weeklyHours",
                  kind: "weekly-hours-boolean",
                  requiredHours: Number(hours[1]),
                };
              return null;
            },
          },
          {
            priority: 32,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:when can you start a new job|what's your earliest start date|(?:when|what date) are you available to begin employment(?: \(month and year\))?|if offered (?:a position, when would you be available to start|employment, how soon could you start work)|when would you be available to start work)[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "start_date",
                  field: "applicationData.earliestStartDate",
                  kind: "exact-date",
                  personal: true,
                };
              return null;
            },
          },
          {
            priority: 38,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:when (?:can|could|would) you (?:start(?: working)?|begin(?: work)?)|(?:what is |please (?:provide|indicate) )?your (?:earliest |anticipated |available |availability )?(?:available )?(?:start|starting) date|(?:earliest |available |availability )?(?:start|starting) date|when (?:are|will) you (?:be )?available to (?:start|begin)(?: (?:work|working|employment|an internship))?)(?:\s*\([^)]*\))?[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "start_date",
                  field: "applicationData.earliestStartDate",
                  kind: "exact-date",
                  personal: true,
                };
              return null;
            },
          },
          {
            priority: 39,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^availability(?:\s*\(month \/ day \/ year\))?[?.:]?$/.test(q)
              )
                return {
                  topic: "start_date",
                  field: "applicationData.earliestStartDate",
                  kind: "exact-date",
                  personal: true,
                  dateControlOnly: true,
                };
              return null;
            },
          },
        ],
      }),
      disclosures: Object.freeze({
        answers: ["eeo", "extended"],
        extended: () => "age",
        facts: ["employmentData"],
        strictness: "qualified",
        resolve: resolveProfileRule,
        optionSpec: answerSpec,
        saved: ordinarySaved,
        recognize: [
          {
            priority: 25,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:what is your race\s*\/\s*ethnicity|please select race\s*\/\s*ethnicity|which ethnicity\(ies\) do you identify with\? please select all that apply)[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "demographic",
                  field: "employmentData.ethnicity",
                  kind: "text",
                  personal: true,
                };
              return null;
            },
          },
          {
            priority: 26,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^what is your gender\? please note, you will be able to select your gender identity in the next question[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "demographic",
                  field: "employmentData.gender",
                  kind: "text",
                  personal: true,
                };
              return null;
            },
          },
          {
            priority: 42,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^are you (?:(?:at least|over the age of) (\d{1,2})(?: years old| years of age)?|(?:(\d{1,2})(?: years old| years of age)? (?:or (?:older|above)|and over)))[?.]?$/.test(
                  q,
                )
              )
                return {
                  topic: "age_threshold",
                  field: "employmentData.age",
                  kind: "age",
                  minimum: Number(q.match(/\d+/)[0]),
                };
              return null;
            },
          },
          {
            priority: 43,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^are you (?:under (?:the age of )?|younger than )(\d{1,2})(?: years old| years of age)?[?.]?$/.test(
                  q,
                )
              )
                return {
                  topic: "age_threshold",
                  field: "employmentData.age",
                  kind: "age",
                  maximumExclusive: Number(q.match(/\d+/)[0]),
                };
              return null;
            },
          },
          {
            priority: 44,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (/^(?:age|what is your age|how old are you)[?.:]?$/.test(q))
                return {
                  topic: "age",
                  field: "employmentData.age",
                  kind: "age",
                };
              return null;
            },
          },
          {
            priority: 46,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:are you hispanic or latino|hispanic or latino|hispanic \/ latino)[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "hispanic",
                  field: "employmentData.hispanicOrLatino",
                  kind: "demographic-boolean",
                };
              return null;
            },
          },
          {
            priority: 47,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:are you a veteran|veteran status|veteran|please (?:select|indicate) (?:the |your )?veteran status (?:which|that) most accurately describes your status)[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "veteran",
                  field: "employmentData.veteran",
                  kind: "demographic-boolean",
                };
              return null;
            },
          },
          {
            priority: 48,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:protected veteran status|are you (?:a |an? )?protected veteran|do you identify as (?:a )?protected veteran)[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "protected_veteran",
                  field: "employmentData.veteran",
                  kind: "demographic-boolean",
                  profileOnly: true,
                };
              return null;
            },
          },
          {
            priority: 49,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:do you have a disability|disability status|disability)[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "disability",
                  field: "employmentData.disability",
                  kind: "demographic-boolean",
                };
              return null;
            },
          },
          {
            priority: 61,
            additional: false,
            match(question, context) {
              const q = normalize(question).replace(/[\s*✱]+$/g, "");
              if (
                /\b(?:age|years old|years of age)\b/.test(q) &&
                /\b(?:are you|have you|will you)\b/.test(q)
              )
                return { topic: "age_condition", managed: false };
              return null;
            },
          },
        ],
      }),
      languages: Object.freeze({
        answers: ["extended"],
        extended: (rule) =>
          rule.kind === "language" ? "language" : "personal",
        facts: [
          "languageData",
          "applicationData.interviewLanguage",
          "applicationData.pronouns",
        ],
        strictness: "exact-fact",
        resolve: resolveProfileRule,
        optionSpec: answerSpec,
        saved: ordinarySaved,
        recognize: [
          {
            priority: 27,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^indicate your proficiency of the english language[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "english_proficiency",
                  field: "languageData.proficiency",
                  kind: "language",
                };
              return null;
            },
          },
          {
            priority: 33,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^preferred programming language\(s\)[?.:]?$/.test(q) ||
                /^if you were to join us for a technical interview, what is your preferred coding language when answering general coding questions\? you may interview in (?:any coding language of your preference\.|any of the 7 coding language options listed below:)$/.test(
                  q,
                )
              )
                return {
                  topic: "interview_language",
                  field: "applicationData.interviewLanguage",
                  kind: "text",
                  personal: true,
                };
              return null;
            },
          },
          {
            priority: 35,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:what is your |please (?:select|specify|provide) your )?(?:preferred|primary|first.choice) (?:interview |coding interview )?(?:programming|coding) language(?: for (?:the |your )?(?:technical |coding )?interview)?[?.:]?$/.test(
                  q,
                ) ||
                /^which (?:programming|coding) language (?:would you (?:prefer|like) to use|do you prefer)(?: (?:in|for) (?:the |your )?(?:technical |coding )?interview)?[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "interview_language",
                  field: "applicationData.interviewLanguage",
                  kind: "text",
                  personal: true,
                };
              return null;
            },
          },
          {
            priority: 56,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:english proficiency|english language proficiency|what is your level of english(?: proficiency)?)[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "english_proficiency",
                  field: "languageData.proficiency",
                  kind: "language",
                };
              return null;
            },
          },
          {
            priority: 57,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:are you fluent in english|do you speak english fluently)[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "english_fluent",
                  field: "languageData.fluent",
                  kind: "language",
                };
              return null;
            },
          },
        ],
      }),
      employment: Object.freeze({
        answers: ["extended"],
        extended: () => "job",
        facts: ["jobData"],
        strictness: "exact-fact",
        resolve: resolveProfileRule,
        optionSpec: answerSpec,
        saved: ordinarySaved,
        recognize: [
          {
            priority: 28,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:have you previously completed at least (?:1|one) internship or have relevant full-time experience|did you previously work or are you currently working as an intern or a co-op)[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "internship_experience",
                  field: "jobData.jobTitle",
                  kind: "internship",
                };
              return null;
            },
          },
          {
            priority: 51,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:current or (?:most )?recent employer|(?:most )?recent employer|name of (?:your )?(?:current or (?:most )?recent|(?:most )?recent) employer)[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "employment_recent",
                  field: "jobData.company",
                  jobField: "company",
                  kind: "job",
                };
              return null;
            },
          },
          {
            priority: 52,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:current employer|current company|name of (?:your )?current employer)[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "employment_current",
                  field: "jobData.company",
                  jobField: "company",
                  kind: "job",
                  currentOnly: true,
                };
              return null;
            },
          },
          {
            priority: 53,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:current job title|current position title)[?.:]?$/.test(q)
              )
                return {
                  topic: "employment_current",
                  field: "jobData.jobTitle",
                  jobField: "jobTitle",
                  kind: "job",
                  currentOnly: true,
                };
              return null;
            },
          },
          {
            priority: 54,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:have you (?:previously )?(?:completed|had|done) (?:at least )?(?:one |an |a )?(?:prior |previous )?internship|do you have (?:any )?(?:prior |previous )?internship experience)[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "internship_experience",
                  field: "jobData.jobTitle",
                  kind: "internship",
                };
              return null;
            },
          },
        ],
      }),
      skills: Object.freeze({
        answers: ["extended"],
        extended: () => "skills",
        facts: ["skillsData"],
        strictness: "exact-fact",
        resolve: resolveProfileRule,
        optionSpec: answerSpec,
        saved: ordinarySaved,
        recognize: [
          {
            priority: 29,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^which scripting\s*\/\s*programming languages do you have experience with[?.:]?$/.test(
                  q,
                )
              )
                return {
                  topic: "programming_languages",
                  field: "skillsData",
                  kind: "skills",
                  languagesOnly: true,
                };
              return null;
            },
          },
          {
            priority: 55,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /^(?:skills|technical skills|list (?:your )?(?:technical )?skills)[?.:]?$/.test(
                  q,
                )
              )
                return { topic: "skills", field: "skillsData", kind: "skills" };
              return null;
            },
          },
        ],
      }),
      salary: Object.freeze({
        answers: ["extended"],
        extended: () => "salary",
        facts: [
          "applicationData.salaryPreference",
          "applicationData.salaryCurrency",
          "applicationData.salaryPeriod",
          "applicationData.salaryMin",
          "applicationData.salaryMax",
        ],
        strictness: "exact-fact",
        resolve: resolveProfileRule,
        optionSpec: answerSpec,
        saved: ordinarySaved,
        recognize: [
          {
            priority: 40,
            additional: true,
            match(question, context) {
              const q = normalize(question)
                .replace(/[\s*✱]+$/g, "")
                .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
              if (
                /\b(?:salary|compensation|pay|remuneration|hourly rate|wage)\b/.test(
                  q,
                )
              ) {
                if (
                  /\b(?:current|previous|past|last|history|paid|earned|earning|bonus|equity|stock|overtime|commission|benefits|comfortable|acceptable|accept|agree|meet|range of|between|at least)\b/.test(
                    q,
                  ) ||
                  /\d/.test(q)
                )
                  return { topic: "salary_detail", managed: false };
                const direct =
                  /\b(?:expected|expectation|expectations|desired|target|requirement|requirements|preferred|minimum|maximum|currency)\b/.test(
                    q,
                  ) ||
                  /^(?:annual (?:base |total )?|hourly |base )?(?:salary|compensation|pay|hourly rate)[?:.]?$/.test(
                    q,
                  );
                if (direct && q.length < 240) {
                  const part = /\bcurrency\b/.test(q)
                    ? "currency"
                    : /\b(?:unit|period|frequency)\b/.test(q)
                      ? "period"
                      : /\bminimum\b/.test(q)
                        ? "minimum"
                        : /\bmaximum\b/.test(q)
                          ? "maximum"
                          : "expectation";
                  return {
                    topic: "salary",
                    field: "applicationData.salaryPreference",
                    kind: "salary",
                    salaryPart: part,
                  };
                }
                return { topic: "salary_detail", managed: false };
              }
              return null;
            },
          },
        ],
      }),
    });
    const recognizedTopics = Object.entries(topicRegistry)
      .flatMap(([theme, definition]) =>
        definition.recognize.map((rule) => ({ ...rule, theme })),
      )
      .sort((a, b) => a.priority - b.priority);
    function classify(question, context = {}) {
      for (const entry of recognizedTopics) {
        const rule = entry.match(question, context);
        if (rule)
          return {
            ...rule,
            theme: entry.theme,
            ...(entry.additional ? { additional: true } : {}),
          };
      }
      return null;
    }

    const managed = (question) => Boolean(classify(question)?.field);
    function classifyWorkFact(q) {
      const rule = (key, topic, extra = {}) => ({
        field: "applicationData." + key,
        topic,
        kind: "work-fact",
        ...extra,
      });
      // Funding a move is a separate fact from willingness to relocate or work
      // onsite. Keep both positive and negative assistance questions unowned.
      if (
        /\brelocat\w*\b/.test(q) &&
        /\b(?:assistance|support|reimbursement|package|expense|expenses|cost|costs|self.fund\w*)\b/.test(
          q,
        )
      )
        return null;
      // Personal facts about residence, eligibility, dates or availability are
      // independent of willingness. A preference cannot satisfy those clauses.
      const compound =
        /\b(?:authori[sz]\w*|citizen\w*|visa|sponsor\w*|clearance|hours?\s*(?:per|a|\/)|\d+\s*h(?:ou)?rs?|arbitration|waiver|contract|binding agreement|within \d+ (?:days|weeks)|by (?:the )?(?:start|hire)|not willing|not able|cannot|unable|unwilling)\b/.test(
          q,
        );
      const dated =
        /\b(?:during|between|from|through|until|starting|beginning|before|after|by)\s+[^?.]*\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec|spring|summer|fall|winter|20\d{2})\b/.test(
          q,
        );
      const related =
        /\b(?:relatives?|family|household|related to|personal relationship|close friends?|romantic relationship|significant relationships?)\b|亲属|近亲|家庭成员|^do you know anyone/.test(
          q,
        );
      const employment =
        /\b(?:work|works|working|employ\w*|board|director|leadership|senior|partner|affiliat\w*|business dealings)\b|任职|受雇|工作|关联/.test(
          q,
        );
      const directRelation =
        /^(?:(?:question body|questionbody)\s*)?(?:\d+[.)]\s*)?(?:to (?:the best of )?your knowledge,?\s*)?(?:do you have|do you know|do any of your|does (?:any|a)|is any member|are you (?:related|a relative)|have (?:any of )?your|to help us avoid conflicts)/.test(
          q,
        ) ||
        /\bplease indicate if you have (?:relatives|significant relationships)/.test(
          q,
        ) ||
        /我有(?:一位)?近亲|是否.*(?:亲属|家庭成员)/.test(q) ||
        /\bare you a relative of a current public official[?.:*]?$/.test(q);
      // A blanket absence is useful across companies. A positive relationship
      // needs the specific person/company, and applicant history is a separate fact.
      if (
        related &&
        employment &&
        directRelation &&
        !/\b(?:have you|are you,? or|you (?:and|or) (?:a |any |your )?(?:close |immediate )?family|confirm|certify|agree|acknowledge|not have|no relatives|disability|veteran|criminal|convict\w*|(?:and|or) (?:are|do) you|(?:any|your) (?:outside business activit\w*|investment|intellectual property))\b/.test(
          q,
        )
      )
        return rule("hasRelatedPeopleAtWork", "work_relationships");
      if (compound || dated) return null;
      const acknowledgement =
        /^do you acknowledge that this is (?:a |an )?(?:hybrid|on[ -]?site|in[ -]?office) (?:role|position)\b/.test(
          q,
        );
      const willingness =
        acknowledgement ||
        /\b(?:are you|would you be|will you be|do you|can you|are or will you be)\s+(?:(?:also|still|currently)\s+)?(?:willing(?:\s*(?:and|or|\/)\s*able)?|able|available|open|interested|prepared|intend)|\bare you able to comply\b|\bis this acceptable to you\b/.test(
          q,
        );
      if (
        (willingness || /\bor (?:intend|plan) to relocate\b/.test(q)) &&
        /\brelocat(?:e|ing|ion)\b/.test(q) &&
        !/\b(?:assistance do you need|require (?:relocation )?assistance|need (?:relocation )?assistance)\b/.test(
          q,
        )
      )
        return rule("willingToRelocate", "relocation", {
          residenceAlternative:
            /\bor\b/.test(q) && /\b(?:reside|live|living|commut\w*)\b/.test(q),
        });
      if (
        (willingness || /\bwould you consider\b/.test(q)) &&
        /\b(?:travell?(?:ing)?|attend on-?site interviews)\b/.test(q)
      )
        return rule("willingToTravel", "travel");
      if (
        willingness &&
        /\bon[ -]?site\b|\bin[ -]?office\b|\bhybrid\b|\b(?:office|headquarters|hq)\b/.test(
          q,
        ) &&
        /\b(?:work|working|come|coming|commute|adhere|comply|require\w*|schedule|onsite|on-site)\b/.test(
          q,
        )
      )
        return rule("willingToWorkOnsite", "onsite");
      return null;
    }
    function resolve(question, profile, context = {}) {
      const rule = classify(question, context);
      if (!rule) return null;
      return topicRegistry[rule.theme].resolve(
        question,
        profile,
        context,
        rule,
      );
    }
    function ordinarySaved() {
      return {};
    }
    function legalSaved() {
      return { countryScoped: true, exactOptions: true };
    }
    function consentMatch(question, context = {}) {
      if (
        context.topicHint !== "consent" &&
        !/\b(?:i (?:agree|consent|acknowledge|certify|accept)|consent to|privacy (?:policy|notice)|gdpr|arbitration|terms (?:of|and))\b/i.test(
          question,
        )
      )
        return null;
      return {
        topic: "consent",
        kind: "consent",
        field: "consent",
        profileOnly: true,
      };
    }
    function consentSaved() {
      return {
        exactOnly: true,
        blockedReason: "consent_requires_current_confirmation",
        blockWhenUnanswered: true,
      };
    }
    function resolveConsent(question, profile, context = {}, rule) {
      const policy = JobsAnswerPolicy?.consent;
      const result = {
        ...rule,
        source: "rule",
        aliases: [],
        profileOnly: true,
      };
      if (context.required === false)
        return {
          ...result,
          answer: "",
          reason: "optional_consent_not_authorized",
        };
      if (!policy || new RegExp(policy.prohibited, "i").test(question))
        return {
          ...result,
          answer: null,
          reason: "consent_requires_current_confirmation",
        };
      const allowed =
        new RegExp(policy.action, "i").test(question) &&
        (new RegExp(policy.privacy, "i").test(question) ||
          new RegExp(policy.reading, "i").test(question) ||
          (policy.applicationAgreements &&
            new RegExp(policy.applicationAgreements, "i").test(question)));
      return {
        ...result,
        answer: allowed ? "Yes" : null,
        aliases: allowed
          ? ["Yes", "I agree", "I consent", "I acknowledge"]
          : [],
        reason: allowed ? "authorized_consent" : "consent_label_insufficient",
      };
    }
    function sponsorshipSaved(question) {
      if (
        /\bsponsor(?:ship)?\b/i.test(question) &&
        /\b(?:f[ -]?1|j[ -]?1|m[ -]?1)\b/i.test(question) &&
        /\b(?:should|must)\s+(?:answer|respond)\s*["“”']?yes\b/i.test(question)
      )
        return { blockedReason: "employer_specific_student_visa_instructions" };
      return legalSaved();
    }
    function workPreferencesSaved(question) {
      const costs =
        /\brelocat\w*\b/i.test(question) &&
        /\b(?:assistance|support|reimbursement|package|expense|expenses|cost|costs|self.fund\w*)\b/i.test(
          question,
        );
      return costs &&
        /\b(?:able|willing|can|could|need|require|without|own)\b/i.test(
          question,
        )
        ? {
            exactOnly: true,
            missingReason: "relocation_assistance_unconfirmed",
          }
        : {};
    }
    function savedAnswerPolicy(question, profile, context, saved) {
      const wording = question.question;
      const key = (value) =>
        String(value || "")
          .normalize("NFKC")
          .toLowerCase()
          .trim()
          .replace(/[\s*?.:]+$/g, "")
          .replace(/\s+/g, " ");
      const classified = classify(wording, context);
      const policy =
        topicRegistry[classified?.theme]?.saved(wording, context) || {};
      // Captured responses remain examples, not authority to insert an unrelated
      // acknowledgment or the applicant's name into a different question.
      if (!/\b(?:agree|acknowledge|certify|consent|accept)\b/i.test(wording))
        saved = saved.filter(
          (rule) =>
            !/^\s*(?:yes[,\s]*)?i\s+(?:agree|acknowledge|consent|accept)\b/i.test(
              rule.response || "",
            ),
        );
      const names = new Set(
        [
          [
            profile?.nameData?.firstName,
            profile?.nameData?.middleName,
            profile?.nameData?.lastName,
          ]
            .filter(Boolean)
            .join(" "),
          [profile?.nameData?.firstName, profile?.nameData?.lastName]
            .filter(Boolean)
            .join(" "),
        ]
          .map(key)
          .filter(Boolean),
      );
      if (
        !/\b(?:your (?:full |legal |preferred )?name|(?:full|legal|preferred) name|signature)\b|^(?:全名|姓名)[*?:：？\s]*$/i.test(
          wording,
        )
      )
        saved = saved.filter((rule) => !names.has(key(rule.response)));
      if (policy.exactOnly || classified?.managed === false)
        saved = saved.filter(
          (rule) => rule.question && key(rule.question) === key(wording),
        );
      const stored = country(profile?.addressData?.country),
        requested = requestedCountry(wording, context, stored);
      const differentCountry =
        policy.countryScoped && requested && requested !== stored;
      if (differentCountry) {
        saved = saved.filter(
          (rule) =>
            (rule.question &&
              requestedCountry(rule.question, {}, null) === requested &&
              key(rule.question) === key(wording)) ||
            (classified?.managed !== false &&
              !["UNKNOWN", "MIXED"].includes(requested) &&
              country((rule.keywords || []).join(" ")) === requested &&
              context.countKeywords(wording, rule.keywords || []) >=
                Math.max(rule.appearances || 0, (rule.keywords || []).length)),
        );
      }
      return { ...policy, classified, saved, differentCountry };
    }
    const primaryAnswers = {
      signature: {
        when(state) {
          let { rule, question, profile, context } = state;
          return (
            /^(?:electronic )?signature[?:.]?$/.test(normalize(question)) &&
            ["checkbox", "custom-checkbox"].includes(
              context.inputType || context.type,
            )
          );
        },
        answer(state) {
          let { rule, question, profile, context } = state;

          const name = [
            profile?.nameData?.firstName,
            profile?.nameData?.middleName,
            profile?.nameData?.lastName,
          ]
            .filter(Boolean)
            .join(" ");
          const recognized =
            context.voluntaryVeteranSignature === true &&
            name &&
            normalize(context.signatureName) === normalize(name);
          // A checkbox needs a boolean answer, never the typed-name answer. Only
          // this identified voluntary IForm has a deterministic checkbox mapping.
          return {
            topic: "signature",
            field: "nameData.fullName",
            kind: "boolean",
            profileOnly: true,
            answer: recognized ? "Yes" : null,
            aliases: recognized ? ["Yes"] : [],
            reason: recognized ? "profile" : "signature_requires_input",
          };
        },
      },
      educationType: {
        when(state) {
          let { rule, question, profile, context } = state;
          return rule.topic === "education_type";
        },
        answer(state) {
          let { rule, question, profile, context } = state;

          const entries = profile?.educationData || [],
            entry = Number.isInteger(context.educationIndex)
              ? entries[context.educationIndex]
              : entries.length === 1
                ? entries[0]
                : null;
          const optionSpec = entry ? educationTypeSpec(entry) : null;
          return optionSpec
            ? {
                ...rule,
                optionSpec,
                answer: optionSpec.answer,
                aliases: optionSpec.tiers.flat(),
                reason: "profile",
              }
            : null;
        },
      },
      source: {
        when(state) {
          let { rule, question, profile, context } = state;
          return rule.topic === "recruiting_source";
        },
        answer(state) {
          let { rule, question, profile, context } = state;

          const optionSpec = recruitingSourceSpec(profile, context);
          return optionSpec
            ? {
                ...rule,
                optionSpec,
                answer: optionSpec.answer,
                aliases: optionSpec.tiers.flat(),
                reason: optionSpec.origin,
                fillingDefault: optionSpec.origin === "default",
              }
            : null;
        },
      },
      catalog: {
        when(state) {
          let { rule, question, profile, context } = state;
          return [
            "addressData.country",
            "addressData.state",
            "contactData.phoneDeviceType",
          ].includes(rule.field);
        },
        answer(state) {
          let { rule, question, profile, context } = state;

          const [group, key] = rule.field.split("."),
            value = profile?.[group]?.[key];
          const optionSpec =
            key === "country"
              ? countrySpec(value)
              : key === "state"
                ? regionSpec(value, profile?.addressData?.country)
                : phoneTypeSpec(value);
          return optionSpec
            ? {
                ...rule,
                optionSpec,
                answer: optionSpec.answer,
                aliases: optionSpec.tiers.flat(),
                reason: "profile",
                fillingDefault:
                  key === "phoneDeviceType" && !String(value ?? "").trim(),
              }
            : {
                ...rule,
                answer: null,
                aliases: [],
                reason: "missing_profile_field",
              };
        },
      },
      eeo: {
        when(state) {
          let { rule, question, profile, context } = state;
          return (() => {
            const eeoTopic =
              rule.field === "employmentData.gender"
                ? "gender"
                : rule.field === "employmentData.ethnicity"
                  ? /\brace\b/i.test(question)
                    ? "race"
                    : "ethnicity"
                  : rule.kind === "demographic-boolean"
                    ? rule.topic
                    : null;
            return eeoTopic;
          })();
        },
        answer(state) {
          let { rule, question, profile, context } = state;
          if (
            rule?.topic === "veteran" &&
            (context.options || []).some((option) =>
              /\bprotected veterans?\b/i.test(
                typeof option === "string" ? option : option.label || "",
              ),
            )
          )
            rule = { ...rule, topic: "protected_veteran", profileOnly: true };
          const eeoTopic =
            rule.field === "employmentData.gender"
              ? "gender"
              : rule.field === "employmentData.ethnicity"
                ? /\brace\b/i.test(question)
                  ? "race"
                  : "ethnicity"
                : rule.kind === "demographic-boolean"
                  ? rule.topic
                  : null;

          const optionSpec = eeoSpec(eeoTopic, profile?.employmentData, {
            knownQuestion: true,
          });
          const aliases = optionSpec?.tiers.flat() || [];
          return {
            ...rule,
            optionSpec,
            answer: optionSpec?.answer || aliases[0] || null,
            aliases,
            reason: aliases.length
              ? "profile"
              : rule.topic === "protected_veteran"
                ? "protected_veteran_status_unconfirmed"
                : "missing_profile_field",
          };
        },
      },
      extended: {
        when(state) {
          let { rule, question, profile, context } = state;
          return (() => {
            const hasExactGraduation = (profile?.educationData || []).some(
              (row) => present(row.graduationDate),
            );
            return (
              rule.additional ||
              rule.topic === "sponsorship" ||
              rule.topic === "work_authorization" ||
              (rule.topic === "graduation" &&
                ((context.inputType || context.type) === "date" ||
                  (hasExactGraduation &&
                    (rule.kind === "exact-date" ||
                      (context.inputType || context.type) === "month"))))
            );
          })();
        },
        answer(state) {
          let { rule, question, profile, context } = state;

          const extended =
            rule.topic === "sponsorship"
              ? { ...rule, timing: sponsorshipTiming(question) }
              : rule;
          const result = resolveAdditional(
            question,
            profile,
            context,
            extended,
          );
          // An absent new optional field does not take ownership away from the
          // existing Saved Answer / AI fallback for unchanged Profiles.
          if (
            rule.additional &&
            !result?.answer &&
            /^missing(?:_|$)/.test(result?.reason || "")
          )
            return null;
          return result ? { ...result, additional: true } : result;
        },
      },
      boolean: {
        when(state) {
          let { rule, question, profile, context } = state;
          return rule.kind === "boolean";
        },
        answer(state) {
          let { rule, question, profile, context } = state;

          const storedCountry = country(profile?.addressData?.country);
          const requestedCountry =
            country(question) || context.country || storedCountry;
          const value = profile?.employmentData?.[rule.field.split(".")[1]];
          const valid =
            typeof value === "boolean" &&
            storedCountry &&
            requestedCountry === storedCountry;
          return {
            ...rule,
            answer: valid ? (value ? "Yes" : "No") : null,
            aliases: valid ? [value ? "Yes" : "No"] : [],
            reason: valid ? "profile" : "missing_or_different_country",
          };
        },
      },
      personal: {
        when(state) {
          let { rule, question, profile, context } = state;
          return rule.personal;
        },
        answer(state) {
          let { rule, question, profile, context } = state;

          const [group, key] = rule.field.split(".");
          const value =
            key === "fullName"
              ? [
                  profile?.nameData?.firstName,
                  profile?.nameData?.middleName,
                  profile?.nameData?.lastName,
                ]
                  .filter(Boolean)
                  .join(" ")
              : profile?.[group]?.[key];
          if (
            rule.profileOnly &&
            profile?.[group] &&
            (value == null || (typeof value === "string" && !value.trim()))
          )
            return {
              ...rule,
              answer: "",
              aliases: [],
              reason: "empty_optional_profile_field",
            };
          if (typeof value !== "string" || !value.trim())
            return {
              ...rule,
              answer: null,
              aliases: [],
              reason: "missing_profile_field",
            };
          const aliases = [value.trim()];
          if (rule.field === "addressData.country" && country(value) === "US")
            aliases.push(
              "United States",
              "United States of America",
              "USA",
              "US",
            );
          return { ...rule, answer: aliases[0], aliases, reason: "profile" };
        },
      },
      exact: {
        when(state) {
          let { rule, question, profile, context } = state;
          return rule.kind === "exact-date";
        },
        answer(state) {
          let { rule, question, profile, context } = state;
          return {
            ...rule,
            answer: null,
            aliases: [],
            reason: "missing_day_precision",
          };
        },
      },
      graduated: {
        when(state) {
          let { rule, question, profile, context } = state;
          return rule.kind === "graduated";
        },
        answer(state) {
          let { rule, question, profile, context } = state;
          const educations = profile?.educationData || [];

          const end = educations.length === 1 ? educations[0].endDate : null;
          const now = context.now || new Date().toISOString().slice(0, 7);
          const future = /^\d{4}-(0[1-9]|1[0-2])$/.test(end || "") && end > now;
          // A past end month alone does not establish that a degree was awarded.
          return {
            ...rule,
            answer: future ? "No" : null,
            aliases: future ? ["No"] : [],
            reason: future ? "profile" : "completion_unconfirmed",
          };
        },
      },
      education: {
        when(state) {
          let { rule, question, profile, context } = state;
          return rule.educationField;
        },
        answer(state) {
          let { rule, question, profile, context } = state;
          const educations = profile?.educationData || [];

          // Multiple degrees require an explicit choice of which education the
          // question refers to (the page section it sits in). Do not silently use the first entry.
          const value = Number.isInteger(context.educationIndex)
            ? educations[context.educationIndex]?.[rule.educationField]
            : educations.length === 1
              ? educations[0][rule.educationField]
              : null;
          if (typeof value !== "string" || !value.trim())
            return {
              ...rule,
              answer: null,
              aliases: [],
              reason: "missing_or_ambiguous_education",
            };
          const aliases = [value.trim()];
          if (rule.educationField === "degree")
            rule = { ...rule, profileOnly: true };
          if (rule.educationField === "degree")
            aliases.push(...degreeTiers(value).flat());
          if (rule.educationField === "gpa") {
            const parts = value
              .trim()
              .match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
            if (parts) aliases.push(parts[1]);
            else if (/scale/i.test(question))
              return {
                ...rule,
                answer: null,
                aliases: [],
                reason: "missing_gpa_scale",
              };
          }
          return {
            ...rule,
            answer:
              rule.kind === "gpa" && !/scale/i.test(question)
                ? aliases.at(-1)
                : aliases[0],
            aliases,
            reason: "profile",
            ...(rule.educationField === "school"
              ? { optionSpec: schoolSpec(value) }
              : {}),
            ...(rule.educationField === "fieldOfStudy"
              ? { optionSpec: fieldOfStudySpec(value) }
              : {}),
            ...(rule.kind === "gpa"
              ? {
                  gpa: Number.parseFloat(value),
                  scale: Number(value.split("/")[1]) || null,
                }
              : {}),
          };
        },
      },
      graduation: {
        when() {
          return true;
        },
        answer(state) {
          let { rule, question, profile, context } = state;
          const educations = profile?.educationData || [];
          const dates = [
            ...new Set(
              educations
                .map((row) => row.endDate)
                .filter((value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value || "")),
            ),
          ];
          if (dates.length !== 1)
            return {
              ...rule,
              answer: null,
              aliases: [],
              reason: "missing_or_ambiguous_education",
            };
          const [year, number] = dates[0].split("-"),
            month = months[Number(number) - 1];
          const aliases = ["year", "month"].includes(rule.kind)
            ? datePartSpec(dates[0], rule.kind).tiers[0]
            : [
                `${month} ${year}`,
                `${month.slice(0, 3)} ${year}`,
                `${number}/${year}`,
                `${year}-${number}`,
              ];
          if (rule.kind === "month-year" && ["05", "12"].includes(number))
            aliases.push(`${number === "05" ? "Spring" : "Fall"} ${year}`);
          return {
            ...rule,
            answer: aliases[0],
            aliases,
            year: Number(year),
            month: Number(number),
            reason: "profile",
          };
        },
      },
    };
    const extendedAnswers = {
      weekly(state) {
        let {
          rule,
          question,
          profile,
          context,
          missing,
          answered,
          application,
        } = state;

        const value = application.weeklyHours;
        if (
          typeof value !== "string" ||
          !["10", "15", "20", "25", "30", "35", "40"].includes(value)
        )
          return missing();
        if (rule.kind === "weekly-hours-boolean")
          return answered(Number(value) >= rule.requiredHours ? "Yes" : "No");
        return answered(value, [
          value,
          `${value} hours`,
          `${value} hours per week`,
          `${value} hours/week`,
          `${value} hrs/week`,
          `${value} 小时／周`,
        ]);
      },
      workFact(state) {
        let {
          rule,
          question,
          profile,
          context,
          missing,
          answered,
          application,
        } = state;

        const value = application[rule.field.split(".")[1]];
        if (typeof value !== "boolean") return missing();
        if (rule.topic === "work_relationships" && value)
          return missing("missing_relationship_scope");
        if (rule.residenceAlternative && !value)
          return missing("missing_residence_context");
        return answered(
          value ? "Yes" : "No",
          value
            ? ["Yes", "是", "是的", "Yes 是的", "Yes 是"]
            : ["No", "否", "没有", "No 没有", "No 否"],
        );
      },
      boolean(state) {
        let {
          rule,
          question,
          profile,
          context,
          missing,
          answered,
          application,
        } = state;

        const storedCountry = country(profile?.addressData?.country);
        const requested = requestedCountry(question, context, storedCountry);
        let value = profile?.employmentData?.[rule.field.split(".")[1]];
        if (rule.topic === "sponsorship") {
          const now = application.sponsorshipNow,
            future = application.sponsorshipFuture;
          const hasNow = typeof now === "boolean",
            hasFuture = typeof future === "boolean";
          if ((hasNow || hasFuture) && rule.timing === "now") {
            value = now;
            rule.field = "applicationData.sponsorshipNow";
          } else if ((hasNow || hasFuture) && rule.timing === "future") {
            value = future;
            rule.field = "applicationData.sponsorshipFuture";
          } else if (hasNow || hasFuture) {
            value =
              now === true || future === true
                ? true
                : hasNow && hasFuture
                  ? false
                  : undefined;
            rule.field =
              "applicationData.sponsorshipNow+applicationData.sponsorshipFuture";
          }
          // Untimed legacy facts cannot answer a question about one specific time period.
          if (!hasNow && !hasFuture && ["now", "future"].includes(rule.timing))
            value = undefined;
          const valid =
            typeof value === "boolean" &&
            storedCountry &&
            requested === storedCountry;
          return valid
            ? answered(value ? "Yes" : "No", [value ? "Yes" : "No"], {
                sponsorshipNow: hasNow ? now : null,
                sponsorshipFuture: hasFuture ? future : null,
                country: requested,
              })
            : missing("missing_or_different_country");
        }
        return typeof value === "boolean" &&
          requested === "US" &&
          storedCountry === requested
          ? answered(value ? "Yes" : "No", [value ? "Yes" : "No"], {
              country: "US",
            })
          : missing("missing_or_different_country");
      },
      salary(state) {
        let {
          rule,
          question,
          profile,
          context,
          missing,
          answered,
          application,
        } = state;

        const preference = application.salaryPreference;
        if (!preference) return missing();
        const period = salaryPeriod(question) || context.salaryPeriod || null,
          currency = salaryCurrency(question) || context.salaryCurrency || null;
        const storedPeriod = application.salaryPeriod,
          storedCurrency = application.salaryCurrency;
        const numeric =
          (context.inputType || context.type) === "number" ||
          /\b(?:dollar amount|numeric(?:al)? (?:amount|answer|value)|number only|digits only)\b/.test(
            normalize(question),
          );
        if (preference !== "custom") {
          if (rule.salaryPart !== "expectation" || numeric)
            return missing("salary_amount_unspecified");
          return preference === "negotiable"
            ? answered(
                "Negotiable",
                ["Negotiable", "Open to discussion", "Flexible"],
                { salaryPreference: preference },
              )
            : preference === "posted_range"
              ? answered(
                  "Within the posted salary range",
                  [
                    "Within the posted salary range",
                    "Within the posted range",
                    "Open to the posted range",
                    "As advertised",
                  ],
                  { salaryPreference: preference },
                )
              : missing();
        }
        if (currency && currency !== storedCurrency)
          return missing("salary_currency_mismatch");
        if (
          period &&
          period !== storedPeriod &&
          !(period === "annual" && /^annual_/.test(storedPeriod)) &&
          !(period === "base" && storedPeriod === "annual_base")
        )
          return missing("salary_period_mismatch");
        const minimum = application.salaryMin,
          maximum = application.salaryMax;
        if (
          !present(minimum) ||
          !/^\d+(?:\.\d{1,2})?$/.test(minimum) ||
          Number(minimum) <= 0 ||
          !present(storedCurrency) ||
          !storedPeriod
        )
          return missing("incomplete_salary");
        if (rule.salaryPart === "currency") return answered(storedCurrency);
        if (rule.salaryPart === "period")
          return answered(
            {
              hourly: "Hourly",
              annual_base: "Annual base salary",
              annual_total: "Annual total compensation",
            }[storedPeriod],
          );
        if (rule.salaryPart === "maximum" && !present(maximum))
          return missing("salary_maximum_unspecified");
        const amount =
          rule.salaryPart === "maximum"
            ? maximum
            : rule.salaryPart === "minimum"
              ? minimum
              : present(maximum) && maximum !== minimum
                ? `${minimum}–${maximum}`
                : minimum;
        const amountOnly =
          numeric ||
          /\b(?:number|numeric|amount only|digits)\b/.test(normalize(question));
        // A number-only answer loses the currency and pay unit; require both from the form.
        if (
          amountOnly &&
          (!period ||
            !currency ||
            period === "annual" ||
            period === "base" ||
            /[–]/.test(amount))
        )
          return missing("salary_numeric_context_incomplete");
        const suffix = {
          hourly: "per hour",
          annual_base: "annual base salary",
          annual_total: "annual total compensation",
        }[storedPeriod];
        const answer = amountOnly
          ? amount
          : `${storedCurrency} ${amount} ${suffix}`;
        return answered(answer, [answer], {
          salaryPreference: preference,
          salaryCurrency: storedCurrency,
          salaryPeriod: storedPeriod,
          salaryMin: Number(minimum),
          salaryMax: present(maximum) ? Number(maximum) : Number(minimum),
          salaryAmountOnly: amountOnly,
        });
      },
      age(state) {
        let {
          rule,
          question,
          profile,
          context,
          missing,
          answered,
          application,
        } = state;

        const age = profile?.employmentData?.age;
        if (typeof age !== "number" || !Number.isInteger(age) || age < 0)
          return missing();
        if (rule.maximumExclusive !== undefined)
          return answered(age < rule.maximumExclusive ? "Yes" : "No");
        if (rule.minimum !== undefined) {
          const result = /over the age/.test(normalize(question))
            ? age > rule.minimum
            : age >= rule.minimum;
          return answered(result ? "Yes" : "No", [result ? "Yes" : "No"]);
        }
        return answered(String(age));
      },
      skills(state) {
        let {
          rule,
          question,
          profile,
          context,
          missing,
          answered,
          application,
        } = state;

        let value = profile?.skillsData;
        if (rule.languagesOnly && Array.isArray(value))
          value = value.filter((skill) =>
            /^(?:python|java|javascript|typescript|c|c\+\+|c#|c sharp|go|golang|rust|ruby|php|swift|kotlin|scala|r|sql|bash|shell|perl|matlab|julia|dart|objective-c)$/i.test(
              skill,
            ),
          );
        // Several skills are several answers for one field (tags, a multi-select).
        return Array.isArray(value) && value.length && value.every(present)
          ? answered(value.join(", "), undefined, {
              answers: [...value],
              ...(value.length === 1
                ? { optionSpec: skillSpec(value[0]) }
                : {}),
            })
          : missing();
      },
      language(state) {
        let {
          rule,
          question,
          profile,
          context,
          missing,
          answered,
          application,
        } = state;

        const rows = (profile?.languageData || []).filter(
          (row) => normalize(row.language) === "english",
        );
        if (rows.length !== 1) return missing("missing_or_ambiguous_language");
        if (rule.topic === "english_fluent")
          return typeof rows[0].fluent === "boolean"
            ? answered(rows[0].fluent ? "Yes" : "No")
            : missing();
        const optionSpec = languageSpec(rows[0].proficiency, rows[0]);
        return optionSpec
          ? answered(optionSpec.answer, optionSpec.tiers.flat(), { optionSpec })
          : missing();
      },
      job(state) {
        let {
          rule,
          question,
          profile,
          context,
          missing,
          answered,
          application,
        } = state;

        let rows = profile?.jobData || [];
        if (rule.kind === "internship")
          return rows.some(
            (row) =>
              /\bintern(?:ship)?\b/i.test(row.jobTitle || "") &&
              ((/^\d{4}-\d{2}$/.test(row.endDate || "") &&
                row.endDate <
                  (context.now || new Date().toISOString().slice(0, 7))) ||
                (/currently working/.test(normalize(question)) &&
                  row.currentlyWorkHere === true)),
          )
            ? answered("Yes")
            : missing("history_not_confirmed_complete");
        if (rule.currentOnly)
          rows = rows.filter((row) => row.currentlyWorkHere === true);
        else if (rows.length > 1) {
          const dated = rows.map((row) => ({
            row,
            date: row.currentlyWorkHere ? "9999-12" : row.endDate,
          }));
          if (
            dated.some(
              (item) => !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(item.date || ""),
            )
          )
            return missing("ambiguous_employment_order");
          const latest = dated
            .map((item) => item.date)
            .sort()
            .at(-1);
          rows = dated
            .filter((item) => item.date === latest)
            .map((item) => item.row);
        }
        const value = rows.length === 1 ? rows[0][rule.jobField] : null;
        return present(value)
          ? answered(value)
          : missing("missing_or_ambiguous_employment");
      },
      personal(state) {
        let {
          rule,
          question,
          profile,
          context,
          missing,
          answered,
          application,
        } = state;

        const [group, key] = rule.field.split(".");
        let value =
          key === "fullName"
            ? [
                profile?.nameData?.firstName,
                profile?.nameData?.middleName,
                profile?.nameData?.lastName,
              ]
                .filter(Boolean)
                .join(" ")
            : profile?.[group]?.[key];
        if (key.startsWith("preferred")) {
          if (!profile?.nameData?.preferredName) {
            if (
              profile?.nameData?.preferredName !== false ||
              context.required !== true
            )
              return missing("preferred_name_unspecified");
            const name = profile.nameData;
            value =
              key === "preferredFullName"
                ? [name.firstName, name.middleName, name.lastName]
                    .filter(Boolean)
                    .join(" ")
                : name[
                    key.replace(/^preferred(.)/, (_match, letter) =>
                      letter.toLowerCase(),
                    )
                  ];
            return present(value)
              ? answered(value)
              : missing("preferred_name_unspecified");
          }
          if (key === "preferredFullName")
            value = [
              profile.nameData.preferredFirstName,
              profile.nameData.preferredMiddleName,
              profile.nameData.preferredLastName,
            ]
              .filter(Boolean)
              .join(" ");
        }
        if (key === "fullAddress")
          value =
            present(profile?.addressData?.line1) &&
            present(profile?.addressData?.city)
              ? [
                  profile?.addressData?.line1,
                  profile?.addressData?.line2,
                  profile?.addressData?.city,
                  profile?.addressData?.state,
                  profile?.addressData?.postalCode,
                  profile?.addressData?.country,
                ]
                  .filter(Boolean)
                  .join(", ")
              : null;
        if (key === "location")
          value = present(profile?.addressData?.city)
            ? [
                profile?.addressData?.city,
                profile?.addressData?.state,
                ...(rule.includePostalCode
                  ? [profile?.addressData?.postalCode]
                  : []),
                ...(/country/.test(normalize(question))
                  ? [profile?.addressData?.country]
                  : []),
              ]
                .filter(Boolean)
                .join(", ")
            : null;
        if (rule.field === "websiteData.personal" && !present(value)) {
          const websites = profile?.websiteData?.websites;
          if (Array.isArray(websites) && websites.length === 1)
            value = websites[0];
          // A direct generic Website prompt can use a known public profile.
          // An ambiguous custom list or a company-website prompt is not inferred.
          if (
            !present(value) &&
            (!websites || websites.length === 0) &&
            /^website(?: url)?[?:.*\s]*$/i.test(question)
          )
            value =
              profile?.websiteData?.github || profile?.websiteData?.linkedin;
        }
        if (
          rule.profileOnly &&
          profile?.[group] &&
          (value == null || (typeof value === "string" && !value.trim()))
        )
          return {
            ...rule,
            answer: "",
            aliases: [],
            reason: "empty_optional_profile_field",
          };
        if (typeof value !== "string" || !value.trim())
          return {
            ...rule,
            answer: null,
            aliases: [],
            reason: "missing_profile_field",
          };
        if (rule.topic === "start_date") {
          let answer = dateAnswer(value, question, context);
          if (
            answer &&
            /month and year/i.test(question) &&
            !["date", "month"].includes(context.inputType || context.type)
          ) {
            const [year, month] = value.split("-");
            answer = months[Number(month) - 1] + " " + year;
          }
          if (!answer) return missing("invalid_date");
          const [year, month, day] = value.split("-");
          return answered(
            answer,
            [
              answer,
              value,
              `${months[Number(month) - 1]} ${Number(day)}, ${year}`,
              `${months[Number(month) - 1].slice(0, 3)} ${Number(day)}, ${year}`,
            ],
            {
              isoDate: value,
              referenceDate:
                context.now || new Date().toISOString().slice(0, 10),
            },
          );
        }
        const aliases =
          rule.kind === "degree" ? degreeAliases(value.trim()) : [value.trim()];
        if (rule.field === "addressData.country" && country(value) === "US")
          aliases.push(
            "United States",
            "United States of America",
            "USA",
            "US",
          );
        if (
          rule.field === "addressData.state" &&
          country(profile?.addressData?.country) === "US"
        ) {
          const state = Object.entries(usStates).find(
            ([code, name]) =>
              normalize(value) === normalize(code) ||
              normalize(value) === normalize(name),
          );
          if (state) aliases.push(...state);
        }
        // A place list picks the applicant's city in its state and country.
        const place =
          key === "location" && !rule.includePostalCode
            ? locationSpec(profile?.addressData)
            : null;
        return {
          ...rule,
          answer: aliases[0],
          aliases,
          reason: "profile",
          ...(place ? { optionSpec: place } : {}),
        };
      },
      education(state) {
        let {
          rule,
          question,
          profile,
          context,
          missing,
          answered,
          application,
        } = state;
        const allEducations = profile?.educationData || [];
        const scopedEducations = Number.isInteger(context.educationIndex)
          ? allEducations.slice(
              context.educationIndex,
              context.educationIndex + 1,
            )
          : allEducations;
        const educations = rule.currentEducationOnly
          ? scopedEducations.filter((row) => row.currentlyAttending === true)
          : scopedEducations;
        if (rule.kind === "gpa-scale") {
          const ratio =
            educations.length === 1
              ? String(educations[0].gpa || "").match(
                  /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/,
                )
              : null;
          return ratio
            ? answered(
                ratio[2],
                [
                  ratio[2],
                  String(Number(ratio[2])),
                  `${Number(ratio[2]).toFixed(1)}`,
                ],
                { scale: Number(ratio[2]) },
              )
            : missing("missing_gpa_scale");
        }
        if (rule.kind === "graduated")
          return resolve(question, profile, context);
        if (rule.educationField) {
          if (rule.kind === "education-boolean") {
            const value =
              educations.length === 1 ? educations[0].currentlyAttending : null;
            if (typeof value !== "boolean")
              return missing("missing_or_ambiguous_education");
            const now = context.now || new Date().toISOString().slice(0, 7),
              end = educations[0].endDate;
            if (
              value === false &&
              /^\d{4}-\d{2}$/.test(end || "") &&
              end >= now
            )
              return missing("education_status_conflict");
            return answered(value ? "Yes" : "No");
          }
          const canonical = {
            school: "School",
            fieldOfStudy: "Field of study",
            degree: "Degree",
            gpa:
              !rule.requiredScale && /scale/i.test(question)
                ? "Cumulative GPA and the scale your school uses (e.g. 3.7/4.0)"
                : "GPA",
          }[rule.educationField];
          const original = resolve(
            canonical,
            { ...profile, educationData: educations },
            context,
          );
          if (rule.requiredScale && original?.scale !== rule.requiredScale)
            return missing("gpa_scale_conversion_unconfirmed");
          return original
            ? { ...original, ...rule }
            : missing("missing_or_ambiguous_education");
        }
        const wantsExact =
          rule.kind === "exact-date" ||
          (context.inputType || context.type) === "date" ||
          /\bdd\b/.test(context.placeholder || "");
        if (wantsExact) {
          if (rule.topic === "education_start")
            return missing("missing_day_precision");
          const exact = educations.map((row) => row.graduationDate),
            valid = exact.filter(dateParts);
          if (
            valid.length !== educations.length ||
            !valid.length ||
            new Set(valid).size !== 1
          )
            return missing("missing_day_precision");
          if (
            educations.some(
              (row) => row.endDate && row.endDate !== valid[0].slice(0, 7),
            )
          )
            return missing("education_date_conflict");
          const answer = dateAnswer(valid[0], question, context);
          return {
            ...answered(answer, [answer, valid[0]], { isoDate: valid[0] }),
            kind: "exact-date",
            field: "educationData.graduationDate",
          };
        }
        const dateField =
          rule.topic === "education_start" ? "startDate" : "endDate";
        const dates = [
          ...new Set(
            educations
              .map((row) => row[dateField])
              .filter((value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value || "")),
          ),
        ];
        if (
          dates.length !== 1 ||
          educations.some(
            (row) => !/^\d{4}-(0[1-9]|1[0-2])$/.test(row[dateField] || ""),
          )
        )
          return {
            ...rule,
            answer: null,
            aliases: [],
            reason: "missing_or_ambiguous_education",
          };
        const canonical =
          rule.kind === "year"
            ? "Graduation year"
            : rule.kind === "month"
              ? "Graduation month"
              : "Graduation date";
        const original = resolve(
          canonical,
          {
            ...profile,
            educationData: educations.map((row) => ({
              ...row,
              endDate: row[dateField],
            })),
          },
          { ...context, inputType: undefined, type: undefined },
        );
        return {
          ...original,
          ...rule,
          answer:
            (context.inputType || context.type) === "month"
              ? dates[0]
              : original.answer,
        };
      },
    };
    function resolveProfileRule(question, profile, context = {}, matchedRule) {
      const rule = matchedRule || classify(question, context);
      if (!rule?.field || (rule.termOptionsOnly && !context.options?.length))
        return null;
      const state = { question, profile, context, rule };
      const strategy = topicRegistry[rule.theme].answers
        .map((name) => primaryAnswers[name])
        .find((item) => item.when(state));
      return strategy?.answer(state) ?? null;
    }

    const disclosureLanguage = (profile) =>
      profile.languageData?.[0]?.language || "English";
    const today = () => {
      const date = new Date();
      return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
      ].join("-");
    };
    function answerSpec(result) {
      if (!result?.answer) return null;
      return (
        result.optionSpec || {
          ...literalSpec(result.topic || "known-answer", result.answer),
          select: (labels) => select(result, labels),
        }
      );
    }
    function select(result, labels) {
      if (result?.optionSpec)
        return labels?.length
          ? JobsOptionMatch.pick(labels, result.optionSpec)?.label || null
          : result.answer;
      if (result?.additional) return selectAdditional(result, labels);
      if (!result?.answer) return null;
      if (result.educationField === "degree" || result.kind === "degree")
        return selectDegree(result.answer, labels);
      if (result.termOptionsOnly) {
        const matching = (labels || []).filter((label) => {
          const match = normalize(label).match(
            /^[a-z]+ \(([a-z]+)\s*[-–—]\s*([a-z]+)\)$/,
          );
          if (!match) return false;
          const from =
              months.findIndex((month) =>
                normalize(month).startsWith(match[1].slice(0, 3)),
              ) + 1,
            to =
              months.findIndex((month) =>
                normalize(month).startsWith(match[2].slice(0, 3)),
              ) + 1;
          return (
            from > 0 && to >= from && from <= result.month && result.month <= to
          );
        });
        return matching.length === 1 ? matching[0] : null;
      }
      if (!labels?.length) return result.answer;
      if (result.educationField === "school") {
        const same = labels.filter((label) =>
          schoolMatches(label, result.answer),
        );
        return same.length === 1 ? same[0] : null;
      }
      const aliases = new Set(result.aliases.map(normalize));
      const exact = labels.filter((label) => aliases.has(normalize(label)));
      if (exact.length === 1) return exact[0];
      if (result.kind === "gpa" && result.scale) {
        const fitting = labels.filter((label) => {
          const value = normalize(label),
            ratio = value.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
          if (ratio)
            return (
              Number(ratio[1]) === result.gpa &&
              Number(ratio[2]) === result.scale
            );
          const numeric = value.match(/^\d+(?:\.\d+)?$/);
          if (numeric) return Number(value) === result.gpa;
          const range = value.match(
            /^(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)$/,
          );
          if (range)
            return (
              Number(range[1]) <= result.gpa &&
              result.gpa <= Number(range[2]) &&
              Number(range[2]) <= result.scale
            );
          const lower = value.match(
            /^(\d+(?:\.\d+)?)\s*(?:\+|or higher|or above)$/,
          );
          return (
            lower &&
            result.gpa >= Number(lower[1]) &&
            Number(lower[1]) <= result.scale
          );
        });
        if (fitting.length === 1) return fitting[0];
      }
      if (result.topic === "graduation") {
        const dated = labels.filter((label) => {
          const dates = [
            ...normalize(label).matchAll(
              /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(20\d{2})\b/g,
            ),
          ];
          if (dates.length !== 2 || !/\s(?:-|–|—|to)\s/.test(label))
            return false;
          const values = dates.map(
            (match) =>
              Number(match[2]) * 12 +
              months.findIndex((month) =>
                normalize(month).startsWith(match[1].slice(0, 3)),
              ) +
              1,
          );
          const value = result.year * 12 + result.month;
          return values[0] <= value && value <= values[1];
        });
        if (dated.length === 1) return dated[0];
      }
      if (result.kind === "boolean") {
        const long = labels.filter(
          (label) =>
            normalize(label).match(/^(yes|no)(?=\s*[-–—,:.]|$)/)?.[1] ===
            normalize(result.answer),
        );
        if (long.length === 1) return long[0];
      }
      return result.topic === "graduation"
        ? selectSameYearRange(result, labels)
        : null;
    }
    function scope(questions) {
      const countries = questions
        .filter(
          (item) =>
            /authori[sz]|eligib|right to work/i.test(item.question) &&
            !/sponsor/i.test(item.question),
        )
        .map((item) => requestedCountry(item.question))
        .filter(Boolean);
      return countries.length
        ? new Set(countries).size === 1
          ? countries[0]
          : "MIXED"
        : null;
    }
    // A topic match alone is not permission to discard an existing answer with
    // finer precision (e.g. a semester or future-only sponsorship).
    function covers(record, profile, context = {}) {
      const result = resolve(record.question, profile, context),
        value = normalize(record.response);
      if (!result?.answer) return false;
      if (
        result.kind === "boolean" ||
        /boolean$/.test(result.kind) ||
        [
          "age_threshold",
          "english_fluent",
          "internship_experience",
          "graduated",
        ].includes(result.topic)
      )
        return /^(yes|no)$/.test(value) && value === normalize(result.answer);
      if (result.topic === "graduation" || result.topic === "education_start") {
        // A year, semester, range or full day carries different precision. Only
        // aliases of the precision requested by this question can be equivalent.
        if (/spring|summer|fall|autumn|winter|\bto\b|[–—]/.test(value))
          return false;
        return result.aliases.some((alias) => normalize(alias) === value);
      }
      if (result.educationField === "school")
        return schoolMatches(record.response, result.answer);
      return result.aliases.some((alias) => normalize(alias) === value);
    }
    // Additive field handlers share the public resolver above. Existing matched
    // fields keep their original branch unless an explicit new fact refines it.
    const usStates = Object.fromEntries(
      "AL:Alabama|AK:Alaska|AZ:Arizona|AR:Arkansas|CA:California|CO:Colorado|CT:Connecticut|DE:Delaware|DC:District of Columbia|FL:Florida|GA:Georgia|HI:Hawaii|ID:Idaho|IL:Illinois|IN:Indiana|IA:Iowa|KS:Kansas|KY:Kentucky|LA:Louisiana|ME:Maine|MD:Maryland|MA:Massachusetts|MI:Michigan|MN:Minnesota|MS:Mississippi|MO:Missouri|MT:Montana|NE:Nebraska|NV:Nevada|NH:New Hampshire|NJ:New Jersey|NM:New Mexico|NY:New York|NC:North Carolina|ND:North Dakota|OH:Ohio|OK:Oklahoma|OR:Oregon|PA:Pennsylvania|RI:Rhode Island|SC:South Carolina|SD:South Dakota|TN:Tennessee|TX:Texas|UT:Utah|VT:Vermont|VA:Virginia|WA:Washington|WV:West Virginia|WI:Wisconsin|WY:Wyoming"
        .split("|")
        .map((item) => item.split(":")),
    );
    const fieldValue = (profile, path) =>
      path.split(".").reduce((value, key) => value?.[key], profile);
    const present = (value) => typeof value === "string" && !!value.trim();
    const dateParts = (value) => {
      if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value || ""))
        return null;
      const date = new Date(value + "T00:00:00Z");
      return !Number.isNaN(date.valueOf()) &&
        date.toISOString().slice(0, 10) === value
        ? value.split("-")
        : null;
    };
    function dateAnswer(value, question, context = {}) {
      const parts = dateParts(value);
      if (!parts) return null;
      const [year, month, day] = parts;
      const hint = normalize(
        question +
          " " +
          (context.placeholder || "") +
          " " +
          (context.format || ""),
      );
      if ((context.inputType || context.type) === "date") return value;
      if ((context.inputType || context.type) === "month")
        return value.slice(0, 7);
      if (/dd\s*[/.-]\s*mm\s*[/.-]\s*yyyy/.test(hint))
        return `${day}/${month}/${year}`;
      if (/mm\s*[/.-]\s*dd\s*[/.-]\s*yyyy/.test(hint))
        return `${month}/${day}/${year}`;
      return value;
    }
    function sponsorshipTiming(text) {
      const q = normalize(text),
        now = /\b(?:now|currently|current|present(?:ly)?|at this time)\b/.test(
          q,
        ),
        future = /\b(?:future|later|eventually)\b/.test(q);
      return now && future
        ? "combined"
        : now
          ? "now"
          : future
            ? "future"
            : "general";
    }
    function requestedCountry(question, context = {}, storedCountry = null) {
      const explicit = country(question);
      if (explicit === "MIXED") return explicit;
      const text = normalize(question)
        .replace(/\bu\.s\.(?:a\.)?/g, "united states")
        .replace(/\bu\.k\./g, "united kingdom")
        .replace(
          /\bnow (?:or|and) in the future\b|\bin the future\b|\bat this time\b/g,
          "",
        )
        .replace(/\bin order to\b/g, "to")
        // Examples in parentheses and what the sponsorship is for (a visa, work authorization) are not places.
        .replace(/\s*\([^)]*\)/g, "")
        .replace(
          /\b(sponsorship|sponsored|sponsoring) for (?:an? |the )?(?:(?:work|employment|employment-based|immigration|h-?1b|tn|o-1|e-3|l-1)[ -]?)*(?:authori[sz]ation|visas?|visa status|status|permit)\b/g,
          "$1",
        );
      const locations = [
        ...text.matchAll(
          /\b(?:work|employment|employed|sponsorship|sponsored|sponsoring|authorization|authorisation|authorized|authorised|eligible|permitted) (?:in|within|for) (?:the )?([^?.:;]+)(?:[?.:;]|$)/g,
        ),
      ];
      const named = [];
      for (const match of locations) {
        const location = match[1]
          .trim()
          .replace(
            /\s+(?:now|currently|in the future|now (?:or|and) in the future)(?:\s+for (?:this|the) (?:job|position|role))?$/,
            "",
          )
          .replace(/\s+for any (?:employer|company)$/, "");
        if (
          !location ||
          /^(?:country (?:where|in which) (?:the |this )?job (?:is )?(?:located|based)|country of (?:employment|the (?:job|position))|this country|your country|(?:this|the) (?:job|position|role)|employment)$/.test(
            location,
          )
        )
          continue;
        const parts = location
          .split(/\s+(?:and|or)\s+|\s*[,/]\s*/)
          .map((part) => country(part.replace(/^the /, ""), { exact: true }));
        if (parts.some((part) => !part)) return "UNKNOWN";
        named.push(...parts);
      }
      if (new Set(named).size > 1) return "MIXED";
      if (named.length) return named[0];
      return explicit || context.country || storedCountry || null;
    }
    function salaryPeriod(text) {
      const q = normalize(text);
      if (/\bhour(?:ly)?\b|\/\s*h(?:r)?\b/.test(q)) return "hourly";
      if (
        /\b(?:total compensation|total annual|annual total|total remuneration|total package)\b/.test(
          q,
        )
      )
        return "annual_total";
      if (/\b(?:annual|yearly|per year)\b/.test(q))
        return /\bbase\b/.test(q) ? "annual_base" : "annual";
      if (/\bbase\b/.test(q)) return "base";
      return null;
    }
    function salaryCurrency(text) {
      const q = String(text || "").toUpperCase();
      return (
        q.match(
          /\b(?:USD|CAD|GBP|EUR|AUD|INR|JPY|SGD|CNY|CHF|NZD|KRW)\b/,
        )?.[0] || (/US\$/.test(q) ? "USD" : null)
      );
    }
    function degreeAliases(value) {
      return [value, ...degreeTiers(value).flat()];
    }

    function resolveAdditional(question, profile, context = {}, matchedRule) {
      let rule = matchedRule || classify(question, context);
      if (
        !rule?.field ||
        (rule.dateControlOnly && (context.inputType || context.type) !== "date")
      )
        return null;
      rule = { ...rule, question };
      const missing = (reason = "missing_profile_field") => ({
        ...rule,
        answer: null,
        aliases: [],
        reason,
      });
      const answered = (answer, aliases = [answer], extra = {}) => ({
        ...rule,
        answer,
        aliases,
        reason: "profile",
        ...extra,
      });
      const state = {
        question,
        profile,
        context,
        rule,
        missing,
        answered,
        application: profile?.applicationData || {},
      };
      const strategy = topicRegistry[rule.theme].extended(rule);
      return extendedAnswers[strategy]?.(state) ?? null;
    }

    const legalOptionPlace =
      "(?:united states(?: of america)?|usa|u\\.s\\.(?:a\\.)?|us|canada|united kingdom|uk|great britain|france|germany|australia|india|china|japan|singapore|ireland|netherlands|mexico|brazil|south korea|new zealand|spain|italy|switzerland|country where (?:the |this )?job is located|country of employment|this country)";
    function legalOptionClaim(result, text, yes) {
      const prose = text.replace(/^(yes|no)\s*[-–—,:.]?\s*/, "");
      if (result.topic === "work_authorization") {
        const affirmative =
          "(?:i am|i'm)(?: currently)?(?: legally|lawfully)? (?:authorized|authorised|eligible|permitted) to work|i have (?:the )?(?:legal )?(?:right|authorization) to work";
        const negative =
          "(?:i am|i'm) not(?: currently)?(?: legally|lawfully)? (?:authorized|authorised|eligible|permitted) to work|i do not have (?:the )?(?:legal )?(?:right|authorization) to work";
        return (
          new RegExp(
            "^(?:" +
              (yes ? affirmative : negative) +
              ")(?: (?:in|within) (?:the )?" +
              legalOptionPlace +
              ")?[.]?$",
          ).test(prose) &&
          requestedCountry(text, {}, result.country) === result.country
        );
      }
      // A Yes/No prefix cannot authorize additional claims or opposite-polarity
      // prose. Only a complete sponsorship clause with supported timing/location
      // qualifiers can refine the direct question.
      const subject = yes
        ? "i (?:(?:do|will|would) )?(?:require|need)"
        : "i (?:(?:do|will|would) not|do not and will not) (?:require|need)";
      const timing =
        "(?: (?:now|currently|at this time|in the future|now (?:or|and) in the future))?";
      const location =
        "(?: to (?:legally )?work in (?:the )?" + legalOptionPlace + ")?";
      return (
        new RegExp(
          "^" +
            subject +
            " (?:(?:visa|immigration|employer) )?(?:sponsorship|immigration support)" +
            timing +
            location +
            "[.]?$",
        ).test(prose) &&
        requestedCountry(text, {}, result.country) === result.country
      );
    }
    function selectAdditional(result, labels) {
      if (!result?.answer) return null;
      if (!labels?.length) return result.answer;
      if (result.topic === "weekly_hours") {
        // Never attach extra date/location promises to a Yes option. Overlapping
        // numeric ranges remain ambiguous instead of silently picking the first.
        const exact = labels.filter((label) =>
          result.aliases.some((value) => normalize(label) === normalize(value)),
        );
        if (exact.length) return exact.length === 1 ? exact[0] : null;
        if (result.kind === "weekly-hours-boolean") return null;
        const ranges = labels.filter((label) => {
          const match = normalize(label).match(
            /^(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)(?:\s*(?:hours?|hrs?)(?:\s*(?:per |a |\/)?week)?)?$/,
          );
          return (
            match &&
            Number(match[1]) <= Number(result.answer) &&
            Number(result.answer) <= Number(match[2])
          );
        });
        return ranges.length === 1 ? ranges[0] : null;
      }
      if (
        result.topic === "education_degree" &&
        /highest level of study/.test(normalize(result.question))
      ) {
        const exact = select({ ...result, additional: false }, labels);
        if (exact) return exact;
        if (/^(?:bachelor|master|phd|doctor)/i.test(result.answer)) {
          const broad = labels.filter((label) =>
            /^university(?: level)?$/i.test(label.trim()),
          );
          if (broad.length === 1) return broad[0];
        }
      }
      if (result.topic === "start_date" && result.isoDate) {
        const [year, month] = result.isoDate.split("-");
        const direct = labels.filter((label) =>
          [
            ...(result.aliases || []),
            result.answer,
            result.isoDate,
            `${months[Number(month) - 1]} ${year}`,
            `${months[Number(month) - 1].slice(0, 3)} ${year}`,
          ].some((value) => normalize(value) === normalize(label)),
        );
        if (direct.length) return direct.length === 1 ? direct[0] : null;
        const delta =
          (Date.parse(result.isoDate + "T00:00:00Z") -
            Date.parse(
              String(result.referenceDate).slice(0, 10) + "T00:00:00Z",
            )) /
          86400000;
        const later = labels.filter((label) => {
          const match = normalize(label).match(
            /^(?:greater than|more than|over) (\d+) weeks?$/,
          );
          return match && delta > Number(match[1]) * 7;
        });
        return later.length === 1 ? later[0] : null;
      }
      if (result.kind === "gpa-scale") {
        const matching = labels.filter((label) => {
          const text = normalize(label),
            range = text.match(
              /^(?:0|1)(?:\.0)?\s*(?:to|[-–—])\s*(\d+(?:\.\d+)?)$/,
            );
          return (
            (result.aliases || []).some((alias) => normalize(alias) === text) ||
            Boolean(range && Number(range[1]) === result.scale)
          );
        });
        return matching.length === 1 ? matching[0] : null;
      }
      if (
        result.topic === "sponsorship" ||
        result.topic === "work_authorization"
      ) {
        const exact = labels.filter((label) =>
          (result.aliases || []).some(
            (alias) => normalize(alias) === normalize(label),
          ),
        );
        if (exact.length === 1) return exact[0];
      }
      if (result.topic === "sponsorship") {
        const selected = labels.filter((label) => {
          const text = normalize(label),
            polarity = text.match(/^(yes|no)(?=\s*[-–—,:.]|$)/)?.[1];
          if (polarity !== normalize(result.answer)) return false;
          const timing = sponsorshipTiming(text),
            yes = polarity === "yes";
          if (!legalOptionClaim(result, text, yes)) return false;
          const legacyTiming =
            result.sponsorshipNow === null &&
            result.sponsorshipFuture === null &&
            result.timing === timing;
          if (legacyTiming) return true;
          if (timing === "now")
            return (
              typeof result.sponsorshipNow === "boolean" &&
              result.sponsorshipNow === yes
            );
          if (timing === "future")
            return (
              typeof result.sponsorshipFuture === "boolean" &&
              result.sponsorshipFuture === yes &&
              (result.sponsorshipNow === false || result.timing === "future")
            );
          if (timing === "combined")
            return yes
              ? result.sponsorshipNow === true ||
                  result.sponsorshipFuture === true
              : result.sponsorshipNow === false &&
                  result.sponsorshipFuture === false;
          return true;
        });
        return selected.length === 1 ? selected[0] : null;
      }
      if (result.topic === "salary" && result.salaryPreference === "custom") {
        const selected = labels.filter((label) => {
          const period = salaryPeriod(label) || salaryPeriod(result.question),
            currency = salaryCurrency(label) || salaryCurrency(result.question);
          if (
            period !== result.salaryPeriod ||
            currency !== result.salaryCurrency
          )
            return false;
          const text = normalize(label).replace(/,/g, ""),
            numbers = text.match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
          if (numbers.length === 1)
            return (
              result.salaryMin === result.salaryMax &&
              numbers[0] === result.salaryMin
            );
          if (numbers.length !== 2 || !/[–—-]|\bto\b/.test(text)) return false;
          return (
            numbers[0] <= result.salaryMin && result.salaryMax <= numbers[1]
          );
        });
        return selected.length === 1 ? selected[0] : null;
      }
      if (result.kind === "boolean") {
        const long = labels.filter((label) => {
          const text = normalize(label),
            polarity = text.match(/^(yes|no)(?=\s*[-–—,:.]|$)/)?.[1];
          if (polarity !== normalize(result.answer)) return false;
          if (result.topic === "work_authorization") {
            return legalOptionClaim(result, text, polarity === "yes");
          }
          return true;
        });
        return long.length === 1 ? long[0] : null;
      }
      const original = select({ ...result, additional: false }, labels);
      if (original) return original;
      return null;
    }
    function selectSameYearRange(result, labels) {
      const sameYearRanges = labels.filter((label) => {
        const text = normalize(label),
          match = text.match(
            /^([a-z]+)\s*(?:\/|[-–—]|to)\s*([a-z]+)\s+(20\d{2})$/,
          );
        if (!match) return false;
        const from =
            months.findIndex((month) =>
              normalize(month).startsWith(match[1].slice(0, 3)),
            ) + 1,
          to =
            months.findIndex((month) =>
              normalize(month).startsWith(match[2].slice(0, 3)),
            ) + 1;
        return (
          from > 0 &&
          to >= from &&
          Number(match[3]) === result.year &&
          from <= result.month &&
          result.month <= to
        );
      });
      return sameYearRanges.length === 1 ? sameYearRanges[0] : null;
    }
    // Profile objects pass through schema parsers which may reorder their keys.
    const signature = (value) =>
      JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
            )
          : item,
      );
    JobsProfileAnswers = Object.freeze({
      topicRegistry,
      savedAnswerPolicy,
      classify,
      managed,
      resolve,
      select,
      answerSpec,
      disclosureLanguage,
      today,
      selectDegree,
      degreeSpec,
      degreeCandidates,
      educationTypeSpec,
      highestEducation,
      eeoSpec,
      recruitingSourceSpec,
      literalSpec,
      knownSpec,
      skillSpec,
      websiteTypeSpec,
      schoolSpec,
      locationSpec,
      datePartSpec,
      countrySpec,
      regionSpec,
      phoneTypeSpec,
      languageSpec,
      scope,
      country,
      requestedCountry,
      normalize,
      covers,
      signature,
      schoolIdentity,
      schoolMatches,
    });
  })();
}
