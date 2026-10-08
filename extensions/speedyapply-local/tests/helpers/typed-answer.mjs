import fs from "node:fs/promises";
const fixture = JSON.parse(
  await fs.readFile(
    new URL("../fixtures/typed-answer-inputs.json", import.meta.url),
    "utf8",
  ),
);
// These unit tests supply the type as an explicit input. They preserve the
// old answer/option regressions without retaining a question classifier.
export function typedAnswer(api, question, profile, context = {}) {
  const key = question.trim().replace(/[?*✱.:\s]+$/, "");
  const id =
    fixture.questions[question] ||
    Object.entries(fixture.questions).find(
      ([label]) => label.trim().replace(/[?*✱.:\s]+$/, "") === key,
    )?.[1];
  const type = fixture.types[id];
  return type
    ? api.answerForType(type, question, profile, context)
    : api.resolve(question, profile, context);
}

export function typedResults(api, fields, profile, context = {}) {
  return fields.flatMap((field, index) => {
    const value = typedAnswer(api, field.question, profile, {
      ...context,
      ...field,
    });
    const answer = api.select(value, field.options);
    return answer
      ? [
          {
            index,
            answer,
            source: value.source || "profile",
            profileAnswer: value,
          },
        ]
      : [];
  });
}
