import { extraProfileAnswer } from "./profile-extra.js";
import { AnswerVocabulary } from "./answer-vocabulary.js";
import { signatureAnswer } from "./signature-answer.js";
import { JobsOptionMatch } from "./option-match.js";
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
    const questionText = (question) =>
      normalize(question)
        .replace(/[\s*✱]+$/g, "")
        .replace(/\s*\((?:optional|required)\)([?:.]?)$/, "$1");
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
        .replace(/\s*\([±~]?\s*\d+ years? of education\)$/, "")
        .replace(/[.'()]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    const degreeLevels = AnswerVocabulary.degreeCatalog.levels;
    /** @type {Array<[string,string[]]>} */
    const degreeTypes = /** @type {any} */ (
      AnswerVocabulary.degreeCatalog.types
    );
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
    // Empty or absent facts remain unknown; only explicit choices mean decline.
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
      value === "I choose not to disclose" || value === "undisclosed";
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
        replaceDefault: (labels) =>
          labels.length === 1 &&
          !!JobsOptionMatch.pick(labels, { tiers: [declineWords] }),
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
        spec.tiers.push([
          value + " Programming",
          value + " Scripting",
          value + " (Programming Language)",
          value + " Programming Language",
        ]);
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
    // Phone pickers can decorate a complete country name with a flag and a
    // leading or trailing dial code. A shared code alone never names a country.
    const dialingCode = /\s*\(?\+\d{1,4}\)?\s*$/;
    const countryLabel = (label) =>
      String(label)
        .trim()
        .replace(/^\p{Regional_Indicator}{2}\s*/u, "")
        .replace(/^\(?\+\d{1,4}\)?\s+/, "")
        .replace(dialingCode, "");
    function countrySpec(value) {
      const result = literalSpec("country", value);
      if (!result) return null;
      const loose = JobsOptionMatch?.loose || normalize;
      result.equals = (label, alias) =>
        loose(countryLabel(label)) === loose(alias);
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
      value = value || (fluent === true ? "Fluent" : "");
      const result = literalSpec("language_proficiency", value);
      if (!result) return null;
      const catalog = AnswerVocabulary.optionConcepts.language_proficiency;
      const groups = [
        catalog.elementary,
        catalog.limited,
        catalog.professional,
        catalog.full_professional,
        catalog.native,
      ];
      const level = groups.findIndex((group) =>
        group.some((alias) => normalize(alias) === normalize(value)),
      );
      result.tiers = [level >= 0 ? groups[level] : [value.trim()]];
      // Catalog ranks decorate the level; they do not change its meaning.
      // Keep this equivalence local to language proficiency, not all options.
      const labelKey = (label) =>
        normalize(label)
          .replace(/^\d+\s*[.)\-:–—]\s*/, "")
          .replace(/\s*\(\d+\)$/, "");
      result.equals = (label, alias) => labelKey(label) === labelKey(alias);
      // A broad fluent/high category is supported by explicit fluency or full
      // professional/native proficiency. It never implies native identity.
      if (level >= 3 || fluent === true || normalize(value) === "fluent")
        result.tiers.push(["Fluent", "High", "Fluent / Native Speaker"]);
      if (level === 3 || fluent === true || normalize(value) === "fluent")
        result.tiers.push(groups[2]);
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
        // Source preferences guide empty fields, not validation of a choice
        // already kept by the site. Explicit application facts stay strict.
        preferenceOnly: true,
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
    // Typed answer functions remain shared by adapters and canonical field labels.
    const topicRegistry = Object.freeze({
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
      }),
      recruiting_source: Object.freeze({
        answers: ["source"],
        extended: () => null,
        facts: ["applicationData.aiNotes"],
        strictness: "exact-fact",
        resolve: resolveProfileRule,
        optionSpec: answerSpec,
      }),
      identity: Object.freeze({
        answers: ["signature", "catalog", "eeo", "extended", "personal"],
        extended: () => "personal",
        facts: ["nameData", "addressData", "contactData", "websiteData"],
        strictness: "exact-fact",
        resolve: resolveProfileRule,
        optionSpec: answerSpec,
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
      }),
      work_authorization: Object.freeze({
        answers: ["extended", "boolean"],
        extended: () => "boolean",
        facts: ["employmentData.eligibilityUS", "addressData.country"],
        strictness: "qualified",
        resolve: resolveProfileRule,
        optionSpec: answerSpec,
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
      }),
      disclosures: Object.freeze({
        answers: ["eeo", "extended"],
        extended: () => "age",
        facts: ["employmentData"],
        strictness: "qualified",
        resolve: resolveProfileRule,
        optionSpec: answerSpec,
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
      }),
      employment: Object.freeze({
        answers: ["extended"],
        extended: () => "job",
        facts: ["jobData"],
        strictness: "exact-fact",
        resolve: resolveProfileRule,
        optionSpec: answerSpec,
      }),
      skills: Object.freeze({
        answers: ["extended"],
        extended: () => "skills",
        facts: ["skillsData"],
        strictness: "exact-fact",
        resolve: resolveProfileRule,
        optionSpec: answerSpec,
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
      }),
    });

    function classify(question, context = {}) {
      // Only unqualified canonical labels stay local. Free-form questions and
      // accompanying conditions go through the server's evidence decision.
      if (context.description?.trim()) return null;
      const label = questionText(question).replace(/[\s*✱?:.]+$/g, "");
      const rule = AnswerVocabulary.localFields[label];
      return rule ? { ...rule } : null;
    }

    const managed = (question) => Boolean(classify(question)?.field);

    function resolve(question, profile, context = {}) {
      const extra = extraProfileAnswer(question, profile, context);
      if (extra) return extra;
      const signed = signatureAnswer(
        questionText(question),
        profile,
        context,
        today(),
      );
      if (signed) return signed;
      return answerForType(
        context.voluntaryVeteranSignature !== undefined &&
          questionText(question) === "signature"
          ? AnswerVocabulary.localFields.signature
          : classify(question, context),
        question,
        profile,
        context,
      );
    }
    function answerForType(rule, question, profile, context = {}) {
      return (
        (rule &&
          topicRegistry[rule.theme]?.resolve(
            question,
            profile,
            context,
            rule,
          )) ||
        null
      );
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
        // An employer is not a country: retain the actual location after it.
        .replace(/\bwork for [^?.:;]+? (in|within) /g, "work $1 ")
        // Examples in parentheses and what the sponsorship is for (a visa, work authorization) are not places.
        .replace(/\s*\([^)]*\)/g, "")
        .replace(
          /\b(sponsorship|sponsored|sponsoring) for (?:an? |the )?(?:(?:united states|united kingdom|canadian|work|employment|employment-based|immigration|h-?1b|tn|o-1|e-3|l-1)[ -]?)*(?:authori[sz]ation|visas?|visa status|status|permit)\b/g,
          "$1",
        )
        .replace(/\bsponsorship for employment\b/g, "sponsorship");
      const locations = [
        ...text.matchAll(
          /\b(?:(?:work|employment|employed|authorization|authorisation|authorized|authorised|eligible|permitted) (?:in|within)|(?:sponsorship|sponsored|sponsoring) (?:in|within|for)) (?:the )?([^?.:;]+)(?:[?.:;]|$)/g,
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
          .replace(/\s+for any (?:employer|company)$/, "")
          // Jurisdiction parsing only: classification retains these conditions.
          .replace(
            /\s+(?:for (?:this|the) (?:job|position|role)|without (?:visa |immigration |employer )?sponsorship|on a (?:full|part)[ -]time basis)$/,
            "",
          );
        if (
          !location ||
          /^(?:country (?:(?:where|in which) (?:the |this )?(?:job|position|role) (?:(?:is|will be) )?(?:located|based)|for which you are applying|you are applying(?: to work in| for (?:the )?(?:job|position|role))?)|country of (?:employment|the (?:job|position))|this country|your country|(?:this|the) (?:job|position|role)|employment)$/.test(
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
    // Follow-up eligibility comes only from explicit labels on the parent
    // question. It never infers personal facts from a selected category.
    function followup(question, { options = [], selected = [] } = {}) {
      const wording = String(question || "")
        .replace(/^\s*(?:\(optional\)\s*)?/i, "")
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'");
      if (
        !/^if\s+(?:(?:you\s+)?(?:selected|select|chose|choose|answered|answer)\b|yes\b|no\b|other\b|["'])/i.test(
          wording,
        )
      )
        return null;
      const unresolved = { active: null };
      const branch = wording.match(
        /^if\s+(?:(?:you\s+)?(?:selected|select|chose|choose|answered|answer)\s+)?((?:"[^"]+"|'[^']+'|yes\b|no\b|other\b)(?:\s+(?:or|and\/or)\s+(?:"[^"]+"|'[^']+'|yes\b|no\b|other\b))*)/i,
      );
      if (!branch || !selected.length) return unresolved;
      const label = (value) =>
        String(value)
          .normalize("NFKC")
          .trim()
          .replace(/[.,:;!?]+$/, "")
          .toLowerCase();
      const expected = [
        ...branch[1].matchAll(/"([^"]+)"|'([^']+)'|\b(yes|no|other)\b/gi),
      ].map((match) => label(match[1] || match[2] || match[3]));
      const available = options.map(label);
      if (
        !expected.every((value) => available.includes(value)) ||
        !selected.every((value) => available.includes(label(value)))
      )
        return unresolved;
      const tail = wording.slice(branch[0].length);
      // An explicit invitation to expand also permits other selected options.
      if (/^\s+or\s+(?:would like|want)\b/i.test(tail)) return { active: true };
      // Do not guess the meaning of a partially parsed compound condition.
      if (/^\s+(?:and|or|but|not)\b/i.test(tail)) return unresolved;
      return {
        active: selected.some((value) => expected.includes(label(value))),
      };
    }
    JobsProfileAnswers = Object.freeze({
      followup,
      topicRegistry,
      classify,
      managed,
      resolve,
      answerForType,
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
