import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs/promises";
import { readModule } from "./helpers/module-source.mjs";
import { installAnswerResolver } from "./helpers/answer-resolver.mjs";

const sandbox = vm.createContext({});
for (const name of ["answer-policy", "option-match", "profile-answers"])
  vm.runInContext(
    await readModule(
      new URL(`../src/custom/${name}.js`, import.meta.url),
      "utf8",
    ),
    sandbox,
  );
const api = sandbox.JobsProfileAnswers;
const resolve = installAnswerResolver(sandbox);
const question = (text) => ({
  question: text,
  options: [],
  type: "checkbox",
  inputType: "checkbox",
  required: true,
  topicHint: "consent",
});

test("required privacy and reading notices share one policy and do not claim Profile facts", async () => {
  for (const text of [
    "I agree to the Privacy Policy.",
    "I consent to processing my personal data for this application.",
    "I acknowledge that I have read the selection criteria.",
    "I have read and consent to the terms and conditions.",
    "I accept terms and conditions.",
    "I agree to the Privacy Policy and arbitration agreement.",
    "I accept the application agreement.",
  ]) {
    const answer = api.resolve(text, {}, question(text));
    assert.equal(answer.answer, "Yes");
    assert.equal(answer.source, "rule");
    const result = await resolve([question(text)], {});
    assert.equal(result[0].answer, "Yes");
    assert.equal(result[0].reason, "authorized_consent");
  }
});

test("factual certifications, unrelated opt-ins and short labels never inherit application consent", async () => {
  for (const text of [
    "I agree",
    "I certify my answers are accurate.",
    "I consent to a background check.",
    "I agree to receive SMS marketing messages.",
    "I consent to biometric data processing.",
  ]) {
    const answer = api.resolve(text, {}, question(text));
    assert.equal(answer.answer, null, text);
    const results = await resolve(
      [question(text)],
      {},
      {
        saved: [
          {
            question: text,
            response: "Yes",
            keywords: ["agree"],
            appearances: 1,
          },
        ],
      },
    );
    assert.equal(results.length, 0, text);
  }
  let decision;
  await resolve(
    [{ ...question("I agree to the Privacy Policy."), required: false }],
    {},
    { onDecision: (value) => (decision = value) },
  );
  assert.equal(decision.status, "omit");
});

test("each registered theme declares fact paths, matching strictness and saved-answer policy", () => {
  for (const [name, theme] of Object.entries(api.topicRegistry)) {
    assert(Array.isArray(theme.facts), name);
    assert(theme.strictness, name);
    assert.equal(typeof theme.resolve, "function", name);
    assert.equal(typeof theme.optionSpec, "function", name);
    assert.equal(typeof theme.saved, "function", name);
    assert(theme.recognize.length, name);
  }
});

test("adapter consent declarations identify controls without authoring their answers", async () => {
  const dir = new URL("../source/content/adapters/", import.meta.url);
  for (const file of await fs.readdir(dir)) {
    const source = await fs.readFile(new URL(file, dir), "utf8");
    for (const line of source.split("\n")) {
      if (
        /agree|consent|privacy|gdpr|acknowledg|declar|arbitration|process-information/.test(
          line,
        ) &&
        /find:/.test(line)
      )
        assert(!/checked\s*:\s*true/.test(line), file + ": " + line.trim());
    }
  }
});
