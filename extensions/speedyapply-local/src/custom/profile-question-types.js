// Shared question types restored from the last pre-regression resolver.
// Recognition only: Profile facts, country/precision checks and actual option
// selection remain in profile-answers. No website, company or saved-value lookup.
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

// Some wrappers repeat the caption and all option labels as help text. This
// adds no condition, but any text beyond those exact readings still does.
export function hasAdditionalDescription(question, context = {}) {
  const caption = (text) => questionText(text).replace(/[\s*✱?:.]+$/g, "");
  const description = caption(context.description);
  if (!description || description === caption(question)) return false;
  const options = (context.options || []).map((option) =>
    questionText(typeof option === "string" ? option : option.label),
  );
  return ![
    options.join(" "),
    [questionText(question), ...options].join(" "),
  ].some((text) => caption(text) === description);
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
    /^can you work (?:from|at|in)\b/.test(q) ||
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
    /\b(?:work|working|being|come|coming|commute|adhere|comply|require\w*|schedule|onsite|on-site)\b/.test(
      q,
    )
  )
    return rule("willingToWorkOnsite", "onsite");
  return null;
}
const topics = {
  consent: [{ priority: -20, match: consentMatch }],
  legal_history: [
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
  education: [
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
        if (
          /\bgraduat(?:e|ed|ing|ion)\b|degree completion|^when do you expect to complete your degree program[?.:]?$/.test(
            q,
          )
        ) {
          if (
            /\b(?:high school|secondary|master|ph\.?d|doctor|spring|summer|fall|autumn|winter|term|timeline|push|delay|extend|before|after|between|within|range|eligible|attending|university of)\b/.test(
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
            /^(?:please select your school from the list|name of (?:your )?(?:school|college|university)|(?:school|college|university|school \/ university)(?: name)?|(?:what|which) (?:school|college|university) (?:(?:do|did) you (?:currently )?attend|are you (?:currently )?attending)|what is the name of the school or institution you currently attend or most recently attended)[?:.]?$/,
          ],
          [
            "fieldOfStudy",
            /^(?:undergrad(?:uate)? disciplines?(?:\(s\))?|please select your major from the list|(?:school |college |university )?major|(?:primary )?field of study|major \/ field of study|what is(?:\/was)? your (?:major(?: or field of study)?|field of study)|please indicate your program major|what major \/ area of study are you pursuing)[?:.]?$/,
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
        const q = questionText(question);
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
        const q = questionText(question);
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
        const q = questionText(question);
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
        const q = questionText(question);
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
        const q = questionText(question);
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
        const q = questionText(question);
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
        const q = questionText(question);
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
        const q = questionText(question);
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
        const q = questionText(question);
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
        const q = questionText(question);
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
        const q = questionText(question);
        if (
          /^(?:are you (?:currently )?(?:enrolled|attending|studying)(?: (?:in|at) (?:a |an )?(?:college|university|school|degree program)| and actively pursuing a degree)?|are you (?:currently )?a student|current(?:ly)? student|still student)[?.:]?$/.test(
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
        const q = questionText(question);
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
        const q = questionText(question);
        const education = /** @type {Array<[string,RegExp]>} */ ([
          [
            "school",
            /^(?:please select your school from the list|name of (?:your )?(?:school|college|university)|(?:current )?(?:school|college|university|school \/ university)(?: name)?|(?:what|which) (?:school|college|university) (?:(?:do|did) you (?:currently )?attend|are you (?:currently )?attending)|what is the name of the school or institution you currently attend or most recently attended)[?:.]?$/,
          ],
          [
            "fieldOfStudy",
            /^(?:undergrad(?:uate)? disciplines?(?:\(s\))?|please select your major from the list|(?:school |college |university )?major(?:\(s\))?|(?:primary )?field of study|major \/ field of study|what is(?:\/was)? your (?:major(?: or field of study)?|field of study)|please indicate your program major|what major \/ area of study are you pursuing)[?:.]?$/,
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
  recruiting_source: [
    {
      priority: 1,
      additional: false,
      match(question, context) {
        const q = normalize(question).replace(/[\s*✱]+$/g, "");
        if (
          /^(?:how did you (?:first )?(?:hear|learn) about (?:us|this (?:job|role|position|opportunity|internship)|our company|[a-z][a-z0-9 &'’.-]{1,70}(?: as an employer)?)|(?:tell us )?how you heard about [a-z][a-z0-9 &'’.-]{1,70}(?: and this job)?|where did you (?:hear about|find|see) (?:us|this (?:job|role|position|opportunity|internship))|(?:application|applicant|candidate|recruiting|referral) source|source)[?!:.]*$/.test(
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
  identity: [
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
        const q = questionText(question);
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
        const q = questionText(question);
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
        const q = questionText(question);
        if (
          /^(?:(?:what (?:is|are)|please (?:provide|specify|share|select|indicate)) (?:your )?)?(?:preferred |personal )?(?:gender )?pronouns(?: do you use)?[?.:]?$/.test(
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
        const q = questionText(question);
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
        const q = questionText(question);
        const personal = /** @type {Array<[string,string,RegExp]>} */ ([
          [
            "name",
            "nameData.fullName",
            /^(?:legal name|full (?:legal )?name|your full name|what is your (?:full |legal )?name|please (?:enter|provide|state) your full (?:legal )?name(?:,? as (?:it )?appears (?:on|in) [^?]{1,80})?)[?:.]?$/,
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
            /^(?:state|province|state\s*\/\s*province|state or province|state of residence|which u\.s\. state or canadian province do you reside in)[?:.]?$/,
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
  sponsorship: [
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
  work_authorization: [
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
        const q = questionText(question);
        if (
          /^(?:are you (?:currently )?(?:(?:legally|lawfully) )?(?:authori[sz]ed|eligible|permitted) to work(?: (?:in|within) .+)?|do you (?:currently )?have (?:the )?(?:legal )?(?:right|authorization) to work(?: in .+)?)[?.]?$/.test(
            q,
          ) &&
          !/\b(?:without|full[ -]time|part[ -]time|hours|restriction|unrestricted|unlimited|permanent|proof|documentation|citizen|clearance|any (?:employer|company)|and|or|but|unless|provided|if)\b/.test(
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
  work_preferences: [
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
  availability: [
    {
      priority: 14,
      additional: true,
      match(question, context) {
        const q = questionText(question);
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
        const q = questionText(question);
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
        const q = questionText(question);
        if (
          /^(?:when can you start a new job|what's your earliest start date|(?:when|what date) are you available to begin employment(?: \(month and year\))?|if offered (?:a position, when would you be available to start|employment, how soon could you start work)|when would you be available (?:to start(?: work)?|if an offer was accepted)|please indicate the specific date you anticipate you'd be available to start a fulltime internship)[?.:]?$/.test(
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
        const q = questionText(question);
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
        const q = questionText(question);
        if (/^availability(?:\s*\(month \/ day \/ year\))?[?.:]?$/.test(q))
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
  disclosures: [
    {
      priority: 25,
      additional: true,
      match(question, context) {
        const q = questionText(question);
        if (
          /^(?:what is your race\s*\/\s*ethnicity|please select race\s*\/\s*ethnicity|which ethnicity\(ies\) do you identify with\? please select all that apply|race \(\*?please select one option that best describes how you identify\*?\))[?.:]?$/.test(
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
        const q = questionText(question);
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
        const q = questionText(question);
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
        const q = questionText(question);
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
        const q = questionText(question);
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
        const q = questionText(question);
        if (
          /^(?:(?:are you|do you identify as) hispanic(?: or |\s*\/\s*)latin[ox]|hispanic(?: or |\s*\/\s*)latin[ox])[?.:]?$/.test(
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
        const q = questionText(question);
        if (
          /^(?:are you a veteran|veterans?\s*(?:\/\s*military\s*)?status|veteran|please select from the veteran statuses below|please (?:select|indicate) (?:the |your )?veteran status(?:(?: which| that) most accurately describes your status|\. to see if you classify as a protected veteran, please click on the link provided above)?)[?.:]?$/.test(
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
        const q = questionText(question);
        if (
          /^(?:protected veteran status|are you (?:a |an? )?protected veteran(?:\? \(veteran status definitions can be found in the instructions above\))?|do you identify as (?:a )?protected veteran|do you identify as one of the following protected veterans \(disabled veteran, recently separated veteran, active duty wartime or campaign badge veteran, armed forces service medal veteran\))[?.:]?$/.test(
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
        const q = questionText(question);
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
  languages: [
    {
      priority: 27,
      additional: true,
      match(question, context) {
        const q = questionText(question);
        if (/^indicate your proficiency of the english language[?.:]?$/.test(q))
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
        const q = questionText(question);
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
        const q = questionText(question);
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
        const q = questionText(question);
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
        const q = questionText(question);
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
  employment: [
    {
      priority: 28,
      additional: true,
      match(question, context) {
        const q = questionText(question);
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
        const q = questionText(question);
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
        const q = questionText(question);
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
        const q = questionText(question);
        if (/^(?:current job title|current position title)[?.:]?$/.test(q))
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
        const q = questionText(question);
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
  skills: [
    {
      priority: 29,
      additional: true,
      match(question, context) {
        const q = questionText(question);
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
        const q = questionText(question);
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
  salary: [
    {
      priority: 40,
      additional: true,
      match(question, context) {
        const q = questionText(question);
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
};
const recognizers = Object.entries(topics)
  .flatMap(([theme, rules]) => rules.map((rule) => ({ ...rule, theme })))
  .sort((a, b) => a.priority - b.priority);
export function classifyProfileQuestion(question, context = {}) {
  for (const entry of recognizers) {
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
