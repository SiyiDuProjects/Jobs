import { JobsResponseContract } from "./response-contract.js";
import { JobsDiagnostics } from "./diagnostics.js";
import { JobsProfileAnswers } from "./profile-answers.js";
import { JobsControlFields } from "./control-fields.js";
import { JobsJobMatch } from "./job-match.js";
export var JobsAnswerResolver;
let initialized = false;
export function initializeAnswerResolver() {
  if (initialized) return;
  initialized = true;
  (() => {
    // The person's saved responses, from the extension's per-Profile store.
    async function readSaved() {
      const result = await chrome.runtime.sendMessage({
        type: "jobs:responses-read",
      });
      if (result?.error) throw Error(result.error);
      const records = JobsResponseContract.readList(result?.data ?? []);
      const rejected =
        (result?.rejected?.length || 0) + records.rejected.length;
      if (rejected)
        JobsDiagnostics?.note(
          "saved_responses_rejected",
          null,
          String(rejected),
        );
      return records.data;
    }
    /** @param {Array<{question:string,country?:string,inputType?:string,type?:string}>} questions @param {object} profile @param {{onDecision?:(decision:object)=>void,root?:Document|Element|ShadowRoot,saved?:Array<object>}} [options] */
    async function resolve(
      questions,
      profile,
      { onDecision, root, saved } = {},
    ) {
      saved ??= await readSaved();
      const personal = JobsProfileAnswers;
      questions =
        JobsControlFields?.describeQuestions?.(questions, { root }) ||
        questions;
      const context = { country: personal?.scope(questions) };
      const decisions = questions.map((question, index) => {
        /** @type {ReturnType<typeof decide> & {index:number,optionSpec?:object}} */
        const decision = {
          index,
          ...decide(
            question,
            profile,
            {
              ...context,
              ...question,
              country: question.country || context.country,
              inputType: question.inputType || question.type,
            },
            saved,
          ),
        };
        if (decision.status === "answered")
          decision.optionSpec = decision.profileAnswer
            ? personal.answerSpec(decision.profileAnswer)
            : {
                ...personal.literalSpec("saved-answer", decision.answer),
                select: (labels) =>
                  matchSaved({ ...question, options: labels }, [
                    { question: question.question, response: decision.answer },
                  ]),
              };
        onDecision?.(decision);
        return decision;
      });
      // The existing batch API returns fillable answers. Every question also has
      // an explicit decision for the caller and diagnostics, including abstentions.
      const results = decisions.filter(
        (decision) => decision.status === "answered",
      );
      JobsDiagnostics?.answers?.(questions, results, decisions);
      return results;
    }
    // One question's decision: the Profile rule, the person's saved answer for
    // that question, or an explicit abstention with its reason.
    function decide(question, profile, context, saved) {
      const personal = JobsProfileAnswers;
      const normalize = (value) =>
        String(value || "")
          .normalize("NFKC")
          .toLowerCase()
          .trim()
          .replace(/[\s*?.:]+$/g, "")
          .replace(/\s+/g, " ");
      const wording = question.question;
      if (question.conditional) {
        const condition = question.conditional;
        if (condition.active !== true)
          return {
            status: condition.active === false ? "omit" : "needs-input",
            answer: null,
            source: "none",
            field: null,
            reason:
              condition.active === false
                ? "conditional_not_applicable"
                : "conditional_parent_unanswered",
            profileAnswer: { profileOnly: true },
          };
        // A generic Other memory has no subject. Accept a complete contextual
        // question, or an authored rule that explicitly names the parent topic.
        const parent = normalize(condition.parentQuestion),
          prompt = normalize(condition.prompt);
        saved = saved.filter(
          (rule) =>
            (rule.question &&
              normalize(rule.question) === normalize(wording)) ||
            (!rule.fromAutofill &&
              rule.keywords?.some(
                (keyword) =>
                  typeof keyword === "string" &&
                  normalize(keyword).length > 2 &&
                  parent.includes(normalize(keyword)) &&
                  !prompt.includes(normalize(keyword)),
              )),
        );
      }
      const policy = personal.savedAnswerPolicy(
        question,
        profile,
        { ...context, countKeywords },
        saved,
      );
      saved = policy.saved;
      const classified = policy.classified;
      let value = personal?.resolve(question.question, profile, context);
      const savedQuestion = policy.exactOptions
        ? { ...question, optionMatch: "exact" }
        : question;
      if (value?.fillingDefault && matchSaved(savedQuestion, saved))
        value = null;
      if (
        policy.blockedReason &&
        (!policy.blockWhenUnanswered || value?.answer == null)
      )
        return {
          status: "needs-input",
          answer: null,
          source: "none",
          field: null,
          reason: policy.blockedReason,
          profileAnswer: { profileOnly: true },
        };
      if (policy.missingReason || policy.differentCountry) {
        const answer = matchSaved(savedQuestion, saved);
        return {
          status: answer ? "answered" : "needs-input",
          answer: answer || null,
          source: answer ? "saved" : "none",
          field: value?.field || null,
          reason: answer
            ? policy.differentCountry
              ? "saved_country_specific"
              : "saved_exact_question"
            : policy.missingReason || "country_mismatch",
          ...(policy.missingReason
            ? { profileAnswer: { profileOnly: true } }
            : {}),
        };
      }
      if (value) {
        if (
          value.profileOnly &&
          value.answer === "" &&
          question.required === false
        )
          return {
            status: "omit",
            answer: "",
            source: "profile",
            field: value.field,
            reason: value.reason,
            profileAnswer: value,
          };
        let answer = personal.select(value, question.options);
        // Formatting belongs to answer selection, not a particular caller.
        if (answer && !question.options?.length) {
          if (context.inputType === "month")
            answer =
              value.aliases?.find((alias) => /^\d{4}-\d{2}$/.test(alias)) ||
              answer;
          else if (context.inputType === "number" && value.kind === "month")
            answer =
              value.aliases?.find((alias) => /^\d{1,2}$/.test(alias)) || answer;
        }
        return {
          status: answer ? "answered" : "needs-input",
          answer: answer || null,
          source: value.source || "profile",
          field: value.field || null,
          reason: answer
            ? value.reason === "authorized_consent"
              ? value.reason
              : "profile"
            : value.answer
              ? "option_not_matched"
              : value.reason || "profile_unavailable",
          profileAnswer: value,
        };
      }
      // A recognized compound/conditional question is different from an unknown
      // topic. Only a memory for that complete question may answer it; a broad
      // keyword rule must not undo the Profile resolver's refusal to infer it.
      const restricted = classified?.managed === false;
      const eligible = restricted
        ? saved.filter(
            (rule) =>
              rule.question &&
              normalize(rule.question) === normalize(question.question),
          )
        : saved;
      let matched;
      const answer = matchSaved(savedQuestion, eligible, (rule, method) => {
        matched = { rule, method };
      });
      const field = classified?.field || null;
      return {
        status: answer
          ? "answered"
          : field || restricted
            ? "needs-input"
            : "unmatched",
        answer: answer || null,
        source: answer ? "saved" : field ? "profile" : "none",
        field,
        reason: answer
          ? matched.method
          : restricted
            ? "unresolved_" + classified.topic + "_wording"
            : field
              ? "profile_unavailable"
              : "no_matching_rule",
        ...(answer && matched?.rule.id ? { ruleId: matched.rule.id } : {}),
      };
    }
    function countKeywords(text, keywords) {
      const normalizedText = text.trim().toLowerCase();
      if (!normalizedText) return 0;
      // Enforce this at the shared counter, so no caller can accidentally count
      // a blank keyword (or count repeated copies of one keyword multiple times).
      const uniqueKeywords = new Set(
        (Array.isArray(keywords) ? keywords : [])
          .filter((keyword) => typeof keyword === "string")
          .map((keyword) => keyword.trim().toLowerCase())
          .filter((keyword) => keyword.length > 0),
      );
      return Array.from(uniqueKeywords).filter((keyword) =>
        normalizedText.includes(keyword),
      ).length;
    }
    // A saved answer for this question: the complete question first, then an
    // explicitly authored keyword rule; either must name one of the options.
    function matchSaved(question, responseRules, onMatch) {
      let normalizedQuestion = question.question.trim().toLowerCase(),
        optionLabels = question.options
          ?.map((e) => e.trim())
          .filter((e) => e.length > 0);
      const jobKey = JobsJobMatch?.key(globalThis.location?.href);
      responseRules = responseRules.filter(
        (rule) => !rule.jobKey || rule.jobKey === jobKey,
      );
      // Old captured drafts have no job identity. Never treat an employer/role
      // answer as universal merely because another company uses the same prompt.
      if (JobsResponseContract?.jobSpecific(question.question))
        responseRules = responseRules.filter(
          (rule) => !rule.fromAutofill || !!rule.jobKey,
        );
      function normalizeOptionText(optionText) {
        return optionText
          .normalize("NFKC")
          .toLowerCase()
          .trim()
          .replace(/[.!?。！？]+$/u, "")
          .replace(/\s+/g, " ");
      }
      function matchResponseOption(response) {
        if (!optionLabels?.length) return response;
        const normalizedResponse = normalizeOptionText(response);
        if (!/[\p{L}\p{N}]/u.test(normalizedResponse)) return null;
        const exact = optionLabels.filter(
          (label) => normalizeOptionText(label) === normalizedResponse,
        );
        if (exact.length) return exact.length === 1 ? exact[0] : null;
        if (question.optionMatch === "exact") return null;
        if (question.optionMatch === "exact-or-unique-boolean") {
          if (!/^(yes|no)$/i.test(response.trim())) return null;
          const candidates = optionLabels.filter(
            (label) =>
              label.toLowerCase().match(/^(yes|no)(?=\s*[-–—,:.]|$)/)?.[1] ===
              response.trim().toLowerCase(),
          );
          return candidates.length === 1 ? candidates[0] : null;
        }
        // Shared words do not establish equivalent answers. In particular, never
        // drop negation, C++/C# symbols, quantities or an option's extra claims.
        // A leading article is the only non-exact wording variation accepted here.
        const withoutArticle = (text) =>
          normalizeOptionText(text).replace(/^(?:a|an|the)\s+/, "");
        const candidates = optionLabels.filter(
          (label) => withoutArticle(label) === withoutArticle(response),
        );
        return candidates.length === 1 ? candidates[0] : null;
      }
      const exactKey = (value) =>
        value
          .normalize("NFKC")
          .toLowerCase()
          .trim()
          .replace(/[\s*?.:：？。]+$/u, "")
          .replace(/\s+/g, " ");
      const exact = responseRules.filter(
        (item) =>
          item.question &&
          exactKey(item.question) === exactKey(question.question) &&
          !item.ignore?.some((word) =>
            normalizedQuestion.includes(word.toLowerCase()),
          ),
      );
      if (exact.length) {
        const rule = exact[exact.length - 1],
          answer = rule.response;
        const normalizedAnswer = normalizeOptionText(answer);
        const candidates = optionLabels?.filter(
          (option) => normalizeOptionText(option) === normalizedAnswer,
        );
        // A declared Yes/No policy (Ashby) applies to an exact saved answer too.
        const selected = optionLabels?.length
          ? /[\p{L}\p{N}]/u.test(normalizedAnswer) && candidates.length === 1
            ? candidates[0]
            : question.optionMatch === "exact-or-unique-boolean" &&
                !candidates.length
              ? matchResponseOption(answer)
              : null
          : answer;
        if (selected) onMatch?.(rule, "saved_exact_question");
        return selected;
      }
      for (let e of responseRules)
        if (
          // Captured answers belong to the complete original question. Only
          // explicitly authored rules may opt into broad keyword matching.
          !(e.fromAutofill && e.question) &&
          !e.ignore?.some((e) =>
            normalizedQuestion.includes(e.toLowerCase()),
          ) &&
          Array.isArray(e.keywords) &&
          e.keywords.some((word) => typeof word === "string" && word.trim()) &&
          Number.isInteger(e.appearances) &&
          e.appearances > 0 &&
          countKeywords(
            normalizedQuestion,
            e.keywords.filter(
              (word) => typeof word === "string" && word.trim(),
            ),
          ) >= e.appearances
        ) {
          let t = matchResponseOption(e.response);
          if (t) {
            onMatch?.(e, "keyword_match");
            return t;
          }
        }
      return null;
    }
    JobsAnswerResolver = Object.freeze({
      resolve,
      decide,
      matchSaved,
      countKeywords,
      readSaved,
    });
  })();
}
