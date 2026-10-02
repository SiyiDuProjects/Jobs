import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = (
  await build({
    stdin: {
      contents: `import {JobsProfileContract} from './src/custom/profile-contract.js';import {defaultProfile,blankEducation} from '../../services/jobs-radar/web/src/manage/model.ts';globalThis.fixture={schema:{parse:JobsProfileContract.assertProfile},defaultProfile,blankEducation};`,
      resolveDir: root,
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  })
).outputFiles[0].text;
test("actual extension Profile parser retains new details, precise graduation date and legacy month", async () => {
  const dom = new JSDOM("<html><body></body></html>", {
    url: "https://fixture.invalid",
    runScripts: "outside-only",
  });
  try {
    const w = dom.window;
    w.chrome = {
      runtime: { id: "fixture" },
      storage: {
        local: {
          get(_keys, callback) {
            callback?.({});
            return Promise.resolve({});
          },
          set(_value, callback) {
            callback?.();
            return Promise.resolve();
          },
          remove(_keys, callback) {
            callback?.();
            return Promise.resolve();
          },
        },
      },
    };
    w.eval(bundle);
    const { schema, defaultProfile, blankEducation } = w.fixture;
    const p = structuredClone(defaultProfile);
    p.educationData = [
      {
        ...blankEducation,
        endDate: "2027-05",
        graduationDate: "2027-05-17",
        currentlyAttending: true,
      },
    ];
    p.applicationData = {
      earliestStartDate: "2027-06-01",
      weeklyHours: "30",
      sponsorshipNow: false,
      sponsorshipFuture: true,
      salaryPreference: "custom",
      salaryCurrency: "USD",
      salaryPeriod: "hourly",
      salaryMin: "40",
      pronouns: "They/them",
      aiNotes: "Confirmed preferences.",
    };
    assert.deepEqual(JSON.parse(JSON.stringify(schema.parse(p))), p);
    await new Promise((resolve) => setTimeout(resolve, 25));
    delete p.applicationData;
    delete p.educationData[0].graduationDate;
    assert.deepEqual(JSON.parse(JSON.stringify(schema.parse(p))), p);
  } finally {
    dom.window.close();
  }
});
