import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import { JSDOM } from "jsdom";
const traverse = traverseModule.default ?? traverseModule;
const root = new URL("../", import.meta.url),
  read = (name) => readModule(new URL(name, root), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const [contract, store, model] = await Promise.all(
  [
    "src/custom/response-contract.js",
    "src/custom/document-store.js",
    "src/custom/management-model.js",
  ].map(read),
);
const examples = JSON.parse(
  await read(
    "../../services/jobs-radar/tests/fixtures/saved-response-contract.json",
  ),
);
function declaration(source, name) {
  let result;
  traverse(parse(source, { sourceType: "unambiguous" }), {
    VariableDeclarator({ node }) {
      if (node.id.name === name)
        result = "var " + source.slice(node.start, node.end) + ";";
    },
    FunctionDeclaration({ node }) {
      if (node.id?.name === name) result = source.slice(node.start, node.end);
    },
  });
  assert(result, "declaration " + name);
  return result;
}
function context(extra = {}) {
  const c = vm.createContext({ console, structuredClone, ...extra });
  vm.runInContext(contract, c);
  return c;
}
test("shared browser/server conformance examples retain Unicode and reject damaged records", () => {
  const c = context(),
    api = c.JobsResponseContract;
  for (const example of examples) {
    if (example.valid) {
      const row = api.normalizeRecord(example.input);
      assert.deepEqual(plain(row.keywords), example.keywords, example.name);
      assert.equal(row.response, example.response);
      assert.equal(row.fromAutofill, false);
    } else
      assert.throws(
        () => api.normalizeRecord(example.input),
        undefined,
        example.name,
      );
  }
  const original = examples.map((row) => row.input),
    before = JSON.stringify(original),
    result = api.readList(original);
  assert.equal(result.data.length, 2);
  assert.equal(result.invalidCount, 9);
  assert.equal(JSON.stringify(original), before);
  assert.equal(result.data[0].source.kind, "confirmed");
  const retained = api.preserveRejected(original, [
    { ...result.data[0], response: "Updated" },
    result.data[1],
  ]);
  assert.equal(retained.length, original.length);
  assert.equal(retained[2], original[2]);
});

test("one contract preserves Chinese answers and job scope through export and import", () => {
  const c = context(),
    api = c.JobsResponseContract;
  const jobKey = '["jobs.ashbyhq.com","path","/fixture/role"]';
  const row = { ...examples[0].input, jobKey };
  const roundtrip = api.parseList(
    JSON.parse(JSON.stringify(api.parseList([row]))),
  )[0];
  assert.deepEqual(plain(roundtrip.keywords), ["全名"]);
  assert.equal(roundtrip.response, "Fixture Applicant");
  assert.equal(roundtrip.source.kind, "confirmed");
  assert.equal(roundtrip.jobKey, jobKey);
  assert.throws(
    () => api.parseList([{ ...row, keywords: ["!!!"] }]),
    /Invalid saved responses/,
  );
  assert.throws(
    () => api.parseList([{ ...row, appearances: 0 }]),
    /Invalid saved responses/,
  );
});

test("document editor isolates damaged history, persists valid edits and rejects new bad rows", async () => {
  const key = "jobsResponses:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    good = examples[0].input,
    bad = examples[2].input;
  const data = { [key]: [good, bad, null] },
    listeners = [];
  const c = context({
    chrome: {
      runtime: {
        id: "fixture",
        onMessage: { addListener: (fn) => listeners.push(fn) },
      },
      storage: {
        local: {
          get: async () => ({}),
          set: async () => assert.fail("Personal response persisted locally"),
        },
        session: {
          getKeys: async () => Object.keys(data),
          get: async () => structuredClone(data),
          set: async (patch) => Object.assign(data, plain(patch)),
        },
      },
    },
  });
  vm.runInContext(model + "\n" + store, c);
  const write = (message) =>
    new Promise((resolve) =>
      listeners[0](
        {
          type: "jobs:responses-edit",
          key,
          base: structuredClone(data[key]),
          ...message,
        },
        { id: "fixture" },
        resolve,
      ),
    );
  assert.equal(
    (await write({ value: [{ ...good, response: "Updated" }] })).ok,
    true,
  );
  assert.equal(data[key][0].response, "Updated");
  assert.deepEqual(data[key].slice(1), [bad, null]);
  const before = structuredClone(data[key]);
  assert.match(
    (await write({ value: [bad] })).error,
    /Invalid saved responses/,
  );
  assert.deepEqual(data[key], before);
  assert.equal(
    (await write({ value: [good], replaceRejected: true })).ok,
    true,
  );
  assert.equal(data[key].length, 1);
});
