export async function requestAnswerBatch(message) {
  try {
    const reply = await chrome.runtime.sendMessage(message);
    if (reply?.error) throw Error(reply.error);
    const answers = reply?.data?.answers,
      ids = new Set(message.fields.map((field) => field.fieldId));
    if (
      !Array.isArray(answers) ||
      answers.length !== ids.size ||
      new Set(answers.map((answer) => answer.fieldId)).size !== ids.size ||
      answers.some((answer) => !ids.has(answer.fieldId))
    )
      throw Error("Invalid answer batch");
    return answers;
  } catch (error) {
    if (message.fields.some((field) => field.required)) throw error;
    // A failed provider cannot turn an optional question into a blocking step.
    // Required requests retain the explicit retry path on the page.
    return message.fields.map((field) => ({
      fieldId: field.fieldId,
      state: "needs_input",
      value: null,
      source: "unknown",
      interruptionReason: "control_failure",
    }));
  }
}
