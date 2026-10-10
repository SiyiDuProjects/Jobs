import { JobsDiagnostics } from "./diagnostics.js";
import { JobsProfileAnswers } from "./profile-answers.js";
import { JobsControlFields } from "./control-fields.js";
export var JobsAnswerResolver;
let initialized = false;
export function initializeAnswerResolver() {
  if (initialized) return;
  initialized = true;
  // Adapters and simple canonical labels share these deterministic functions.
  // Free-form claims and saved-answer conflicts belong to the server decision.
  function decide(question, profile, context = {}) {
    if (question.descriptionIncomplete)
      return {
        status: "unmatched",
        answer: null,
        source: "none",
        field: null,
        reason: "field_description_incomplete",
      };
    if (question.conditional?.active === false)
      return {
        status: "omit",
        answer: null,
        source: "none",
        field: null,
        reason: "conditional_not_applicable",
      };
    const personal = JobsProfileAnswers;
    const value = personal.resolve(question.question, profile, context);
    if (!value || value.fillingDefault)
      return {
        status: "unmatched",
        answer: null,
        source: "none",
        field: null,
        reason: "server_decision_required",
      };
    if (value.profileOnly && value.answer === "" && question.required === false)
      return {
        status: "omit",
        answer: "",
        source: "profile",
        field: value.field,
        reason: value.reason,
        profileAnswer: value,
      };
    let answer = personal.select(value, question.options);
    if (answer && !question.options?.length) {
      if (context.inputType === "month")
        answer =
          value.aliases?.find((alias) => /^\d{4}-\d{2}$/.test(alias)) || answer;
      else if (context.inputType === "number" && value.kind === "month")
        answer =
          value.aliases?.find((alias) => /^\d{1,2}$/.test(alias)) || answer;
    }
    return {
      status: answer ? "answered" : "unmatched",
      answer: answer || null,
      source: value.source || "profile",
      field: value.field || null,
      reason: answer ? "profile" : "server_decision_required",
      profileAnswer: value,
    };
  }
  /** @param {Array<any>} questions @param {object} profile @param {{onDecision?:(decision:any)=>void,root?:Document|Element|ShadowRoot}} [options] */
  async function resolve(questions, profile, { onDecision, root } = {}) {
    questions =
      JobsControlFields?.describeQuestions?.(questions, { root }) || questions;
    const country = JobsProfileAnswers.scope(questions);
    const decisions = questions.map((question, index) => {
      /** @type {any} */
      const decision = {
        index,
        ...decide(question, profile, {
          ...question,
          country: question.country || country,
          inputType: question.inputType || question.type,
        }),
      };
      if (decision.status === "answered")
        decision.optionSpec = JobsProfileAnswers.answerSpec(
          decision.profileAnswer,
        );
      onDecision?.(decision);
      return decision;
    });
    const results = decisions.filter(
      (decision) => decision.status === "answered",
    );
    JobsDiagnostics?.answers?.(questions, results, decisions);
    return results;
  }
  JobsAnswerResolver = Object.freeze({ resolve, decide });
}
