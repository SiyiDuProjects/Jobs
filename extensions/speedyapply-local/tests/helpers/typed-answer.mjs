// Keep older fixture signatures, but exercise the real question recognizer.
// Supplying a frozen type here hid lost routing before the shared-layer repair.
export function typedAnswer(api, question, profile, context = {}) {
  return api.resolve(question, profile, context);
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
