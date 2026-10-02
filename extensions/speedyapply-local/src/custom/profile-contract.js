// Generated from jobs_radar/profile.schema.json. Do not edit.
// JSON Schema runtime for the keywords used by profile.schema.json.
// Build checks reject unsupported validation keywords before producing an artifact.
function makeProfileContract(schema) {
  const fail = (path, message = "Invalid Profile field") => {
    throw Error(`${path || "Profile"}: ${message}`);
  };
  const object = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  function optionalDate(value) {
    if (value === "") return true;
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    if (!year || month < 1 || month > 12 || day < 1) return false;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return (
      day <=
      [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    );
  }
  const amount = (value) =>
    typeof value === "string" &&
    /^[0-9]+(?:\.[0-9]{1,2})?$/.test(value) &&
    /[1-9]/.test(value);
  const cents = (value) =>
    BigInt(value.split(".")[0]) * 100n +
    BigInt((value.split(".")[1] || "").padEnd(2, "0"));
  function check(node, value, path) {
    if (node.anyOf) {
      if (
        !node.anyOf.some((branch) => {
          try {
            check(branch, value, path);
            return true;
          } catch {
            return false;
          }
        })
      )
        fail(path);
      return;
    }
    const matches = {
      object,
      array: Array.isArray,
      string: (v) => typeof v === "string",
      boolean: (v) => typeof v === "boolean",
      number: (v) => typeof v === "number" && Number.isFinite(v),
      integer: (v) => Number.isInteger(v),
    };
    if (node.type && !matches[node.type](value)) fail(path);
    if (node.enum && !node.enum.includes(value)) fail(path);
    if (typeof value === "string") {
      const length = [...value].length;
      if (
        length < (node.minLength || 0) ||
        length > (node.maxLength ?? Infinity) ||
        (node.pattern && !new RegExp(node.pattern, "u").test(value))
      )
        fail(path);
      if (node.format === "optional-date" && !optionalDate(value)) fail(path);
    }
    if (typeof value === "number" && value < (node.minimum ?? -Infinity))
      fail(path);
    if (Array.isArray(value) && node.items)
      value.forEach((item, index) =>
        check(node.items, item, `${path}.${index}`),
      );
    if (object(value)) {
      for (const key of node.required || [])
        if (!(key in value)) fail(`${path}.${key}`);
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue; // Absent optional form values serialize as omitted JSON members.
        if (node.properties?.[key])
          check(node.properties[key], item, path ? `${path}.${key}` : key);
        else if (node.additionalProperties === false)
          fail(path ? `${path}.${key}` : key);
      }
      for (const rule of node["x-invariants"] || []) {
        if (
          rule.kind === "dateMonth" &&
          value[rule.date] &&
          value[rule.month] !== value[rule.date].slice(0, 7)
        )
          fail(path, rule.message);
        if (rule.kind === "salary" && value[rule.when] === rule.equals) {
          if (
            !/^[A-Z]{3}$/.test(value[rule.currency] || "") ||
            !value[rule.period] ||
            !amount(value[rule.minimum]) ||
            (value[rule.maximum] && !amount(value[rule.maximum]))
          )
            fail(path, rule.message);
          if (
            value[rule.maximum] &&
            cents(value[rule.maximum]) < cents(value[rule.minimum])
          )
            fail(path, "薪资上限不能低于下限。");
        }
      }
    }
  }
  function credentials(value) {
    if (object(value)) {
      if (
        Object.keys(value).some((key) =>
          schema["x-forbiddenKeys"].includes(key.toLowerCase()),
        )
      )
        throw Error("Credentials are not Profile data");
      Object.values(value).forEach(credentials);
    } else if (Array.isArray(value)) value.forEach(credentials);
  }
  function assertProfile(value) {
    credentials(value);
    check(schema, value, "");
    if (
      new TextEncoder().encode(JSON.stringify(value)).length >
      schema["x-maxBytes"]
    )
      throw Error("Profile exceeds 8 MB");
    return value;
  }
  function projectAnswerProfile(value, { partial = false } = {}) {
    if (!object(value)) throw Error("Invalid answer Profile");
    const policies = schema["x-answerProjection"];
    if (partial) {
      if (
        Object.keys(value).some(
          (key) => !policies[key] || policies[key].mode === "exclude",
        )
      )
        throw Error("Invalid answer Profile");
      const defaults = Object.fromEntries(
        schema.required
          .filter((key) => key !== "profileName")
          .map((key) => [
            key,
            schema.properties[key].type === "array" ? [] : {},
          ]),
      );
      assertProfile({ ...defaults, ...value });
    } else assertProfile(value);
    const result = {};
    for (const [key, policy] of Object.entries(policies)) {
      if (policy.mode === "exclude" || value[key] === undefined) continue;
      result[key] =
        policy.mode === "project"
          ? Object.fromEntries(
              policy.include
                .filter((child) => value[key][child] !== undefined)
                .map((child) => [child, value[key][child]]),
            )
          : value[key];
    }
    return structuredClone(result);
  }
  function validate(value) {
    try {
      assertProfile(value);
      return { valid: true, errors: [] };
    } catch (error) {
      return { valid: false, errors: [error.message] };
    }
  }
  return Object.freeze({
    version: schema["x-version"],
    schema,
    options: schema["x-uiOptions"],
    assertProfile,
    validate,
    projectAnswerProfile,
  });
}

export const JobsProfileContract = makeProfileContract({"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://jobs.siyidu.com/contracts/profile.schema.json","title":"Profile","description":"Server-owned Profile contract. Missing optional facts mean unknown; false is explicit No. Additional legacy properties are retained, never stripped. Schema version is in record metadata, not personal facts.","x-version":1,"type":"object","properties":{"profileName":{"type":"string","minLength":1,"maxLength":200,"pattern":"\\S"},"nameData":{"type":"object","properties":{"firstName":{"type":"string"},"middleName":{"type":"string"},"lastName":{"type":"string"},"prefix":{"type":"string"},"suffix":{"type":"string"},"preferredFirstName":{"type":"string"},"preferredMiddleName":{"type":"string"},"preferredLastName":{"type":"string"},"preferredName":{"type":"boolean"}},"additionalProperties":true},"addressData":{"type":"object","properties":{"line1":{"type":"string"},"line2":{"type":"string"},"city":{"type":"string"},"state":{"type":"string"},"postalCode":{"type":"string"},"country":{"type":"string"}},"additionalProperties":true},"contactData":{"type":"object","properties":{"email":{"type":"string"},"phoneNumber":{"type":"string"},"phoneCountryCode":{"type":"string"},"phoneDeviceType":{"type":"string"}},"additionalProperties":true},"jobData":{"type":"array","items":{"type":"object","properties":{"jobTitle":{"type":"string"},"company":{"type":"string"},"location":{"type":"string"},"startDate":{"type":"string"},"endDate":{"type":"string"},"description":{"type":"string"},"currentlyWorkHere":{"type":"boolean"}},"additionalProperties":true}},"educationData":{"type":"array","items":{"type":"object","properties":{"school":{"type":"string"},"degree":{"type":"string"},"fieldOfStudy":{"type":"string"},"startDate":{"type":"string"},"endDate":{"type":"string"},"gpa":{"type":"string"},"currentlyAttending":{"type":"boolean"},"graduationDate":{"type":"string","format":"optional-date"}},"additionalProperties":true,"x-invariants":[{"kind":"dateMonth","date":"graduationDate","month":"endDate","message":"Graduation date must match graduation month"}]}},"languageData":{"type":"array","items":{"type":"object","properties":{"language":{"type":"string"},"proficiency":{"type":"string"},"fluent":{"type":"boolean"}},"additionalProperties":true}},"resumeData":{"type":"object","properties":{"resumeBase64":{"type":"string"},"fileName":{"type":"string"},"dateUploaded":{"type":"string"},"fileSize":{"type":"number","minimum":0,"description":"File size in KiB, retained for compatibility with existing Profiles."}},"additionalProperties":true},"websiteData":{"type":"object","properties":{"websites":{"type":"array","items":{"type":"string"}},"linkedin":{"type":"string"},"github":{"type":"string"},"portfolio":{"type":"string"}},"additionalProperties":true},"employmentData":{"type":"object","properties":{"gender":{"type":"string"},"ethnicity":{"type":"string"},"age":{"anyOf":[{"type":"integer","minimum":0},{"type":"string"}]},"eligibilityUS":{"anyOf":[{"type":"boolean"},{"type":"string","enum":["undisclosed",""]}]},"sponsorship":{"anyOf":[{"type":"boolean"},{"type":"string","enum":["undisclosed",""]}]},"disability":{"anyOf":[{"type":"boolean"},{"type":"string","enum":["undisclosed",""]}]},"veteran":{"anyOf":[{"type":"boolean"},{"type":"string","enum":["undisclosed",""]}]},"hispanicOrLatino":{"anyOf":[{"type":"boolean"},{"type":"string","enum":["undisclosed",""]}]}},"additionalProperties":true},"skillsData":{"type":"array","items":{"type":"string"}},"applicationData":{"type":"object","properties":{"earliestStartDate":{"type":"string","maxLength":200,"format":"optional-date"},"weeklyHours":{"type":"string","maxLength":200,"enum":["","10","15","20","25","30","35","40"]},"highestCompletedEducation":{"type":"string","maxLength":200},"visaStatus":{"type":"string","maxLength":200},"salaryPreference":{"type":"string","maxLength":200,"enum":["","posted_range","negotiable","custom"]},"salaryCurrency":{"type":"string","maxLength":200},"salaryPeriod":{"type":"string","maxLength":200,"enum":["","hourly","annual_base","annual_total"]},"salaryMin":{"type":"string","maxLength":200},"salaryMax":{"type":"string","maxLength":200},"pronouns":{"type":"string","maxLength":200},"interviewLanguage":{"type":"string","maxLength":200},"aiNotes":{"type":"string","maxLength":8000},"sponsorshipNow":{"type":"boolean"},"sponsorshipFuture":{"type":"boolean"},"willingToRelocate":{"type":"boolean"},"willingToWorkOnsite":{"type":"boolean"},"willingToTravel":{"type":"boolean"},"hasRelatedPeopleAtWork":{"type":"boolean"}},"additionalProperties":false,"x-invariants":[{"kind":"salary","when":"salaryPreference","equals":"custom","minimum":"salaryMin","maximum":"salaryMax","currency":"salaryCurrency","period":"salaryPeriod","message":"请填写有效的薪资金额、计薪方式和三位币种代码。"}]}},"required":["profileName","nameData","addressData","contactData","jobData","educationData","languageData","resumeData","websiteData","employmentData"],"additionalProperties":false,"x-maxBytes":8388608,"x-forbiddenKeys":["password","accountpassword","token","api_key","apikey"],"x-answerProjection":{"profileName":{"mode":"include"},"nameData":{"mode":"include"},"addressData":{"mode":"project","include":["city","state","country"],"exclude":["line1","line2","postalCode"],"reason":"Coarse residence supports location questions; exact street and postal fields are resolved locally. Residence does not establish work authorization."},"contactData":{"mode":"exclude","reason":"Email and telephone are resolved locally without a provider call."},"jobData":{"mode":"include"},"educationData":{"mode":"include"},"languageData":{"mode":"include"},"resumeData":{"mode":"exclude","reason":"Do not transmit binary resume content or attachment metadata as answer context."},"websiteData":{"mode":"include"},"employmentData":{"mode":"include"},"skillsData":{"mode":"include"},"applicationData":{"mode":"include"}},"x-uiOptions":{"degrees":["Bachelor's","Bachelor of Arts","Master's","MBA","PhD","PharmD","Associate's","High School","GED","Other"],"languages":["Afrikaans","Akan","Albanian","Amharic","Arabic","Armenian","Assamese","Azerbaijani","Basque","Belarusian","Bengali","Bhojpuri","Bosnian","Bulgarian","Burmese","Cantonese","Catalan","Cebuano","Chinese","Croatian","Czech","Danish","Dari","Dutch","Dzongkha","English","Estonian","Farsi","Finnish","French","Gaelic","Galician","Georgian","German","Greek","Gujarati","Haitian","Hakka","Hausa","Hebrew","Hiligaynon","Hindi","Hmong","Hungarian","Icelandic","Igbo","Ilokano","Indonesian","Irish","Italian","Japanese","Kannada","Kazakh","Khmer","Kirundi","Konkani","Korean","Kurdish","Kyrgyz","Lao","Latin","Latvian","Lithuanian","Macedonian","Maithili","Malagasy","Malay","Malay/Indonesian","Malayalam","Maltese","Mandarin","Marathi","Marwari","Min Nan","Mongolian","Nepali","Norwegian","Oriya","Pashto","Persian","Polish","Portuguese","Punjabi","Quechua","Romanian","Russian","Serbian","Serbo-Croatian","Shona","Sindhi","Sinhala","Slovak","Slovene","Somali","Spanish","Sundanese","Swahili","Swedish","Tagalog","Tagalog-Filipino","Tajik","Tamil","Telugu","Thai","Tibetan","Turkish","Turkmen","Uighur","Ukrainian","Urdu","Uzbek","Vietnamese","Xhosa","Yoruba","Zulu"],"proficiencies":["Beginner","Intermediate","Advanced","Full Professional Proficiency","Native"],"genders":["Male","Female","Non-Binary","I choose not to disclose"],"ethnicities":["American Indian or Alaska Native","Asian","Black or African American","Hispanic or Latino","Native Hawaiian or Other Pacific Islander","White","I choose not to disclose"],"countries":["Afghanistan","脜land Islands","Albania","Algeria","American Samoa","Andorra","Angola","Anguilla","Antigua and Barbuda","Argentina","Armenia","Aruba","Australia","Austria","Azerbaijan","Bahamas","Bahrain","Bangladesh","Barbados","Belarus","Belgium","Belize","Benin","Bermuda","Bhutan","Bolivia","Bonaire, Sint Eustatius, and Saba","Bosnia and Herzegovina","Botswana","Bouvet Island","Brazil","British Indian Ocean Territory","British Virgin Islands","Brunei","Bulgaria","Burkina Faso","Burundi","Cabo Verde","Cambodia","Cameroon","Canada","Cayman Islands","Central African Republic","Chad","Chile","China","Christmas Island","Cocos (Keeling) Islands","Colombia","Comoros","Congo","Congo, Democratic Republic of the","Cook Islands","Costa Rica","C么te d'Ivoire","Croatia","Cuba","Cura莽ao","Cyprus","Czechia","Denmark","Djibouti","Dominica","Dominican Republic","Ecuador","Egypt","El Salvador","Equatorial Guinea","Eritrea","Estonia","Eswatini","Ethiopia","Falkland Islands","Faroe Islands","Fiji","Finland","France","French Guiana","French Polynesia","French Southern Territories","Gabon","Gambia","Georgia","Germany","Ghana","Gibraltar","Greece","Greenland","Grenada","Guadeloupe","Guam","Guatemala","Guernsey","Guinea","Guinea-Bissau","Guyana","Haiti","Heard Island and McDonald Islands","Holy See (Vatican City State)","Honduras","Hong Kong","Hungary","Iceland","India","Indonesia","Iran","Iraq","Ireland","Isle of Man","Israel","Italy","Jamaica","Japan","Jersey","Jordan","Kazakhstan","Kenya","Kiribati","Korea, Democratic People's Republic of","Korea, Republic of","Kosovo","Kuwait","Kyrgyzstan","Laos","Latvia","Lebanon","Lesotho","Liberia","Libya","Liechtenstein","Lithuania","Luxembourg","Macao","Madagascar","Malawi","Malaysia","Maldives","Mali","Malta","Marshall Islands","Martinique","Mauritania","Mauritius","Mayotte","Mexico","Micronesia, Federated States of","Moldova","Monaco","Mongolia","Montenegro","Montserrat","Morocco","Mozambique","Myanmar","Namibia","Nauru","Nepal","Netherlands","New Caledonia","New Zealand","Nicaragua","Niger","Nigeria","Niue","Norfolk Island","Northern Mariana Islands","North Macedonia","Norway","Oman","Pakistan","Palau","Panama","Papua New Guinea","Paraguay","Peru","Philippines","Pitcairn Islands","Poland","Portugal","Puerto Rico","Qatar","Reunion","Romania","Russian Federation","Rwanda","Saint Barthelemy","Saint Helena, Ascension and Tristan da Cunha","Saint Kitts and Nevis","Saint Lucia","Saint Martin","Saint Pierre and Miquelon","Saint Vincent and the Grenadines","Samoa","San Marino","Sao Tome and Principe","Saudi Arabia","Senegal","Serbia","Seychelles","Sierra Leone","Singapore","Sint Maarten","Slovakia","Slovenia","Solomon Islands","Somalia","South Africa","South Georgia and the South Sandwich Islands","South Sudan","Spain","Sri Lanka","State of Palestine","Sudan","Suriname","Svalbard and Jan Mayen","Sweden","Switzerland","Syria","Taiwan","Tajikistan","Tanzania","Thailand","Timor-Leste","Togo","Tokelau","Tonga","Trinidad and Tobago","Tunisia","T眉rkiye","Turkmenistan","Turks and Caicos Islands","Tuvalu","U. S. Virgin Islands","Uganda","Ukraine","United Arab Emirates","United Kingdom","United States Minor Outlying Islands","United States of America","Uruguay","Uzbekistan","Vanuatu","Venezuela","Vietnam","Wallis and Futuna","Western Sahara","Yemen","Zambia","Zimbabwe"]}});
