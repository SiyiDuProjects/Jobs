import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
const platform = await readModule(
  new URL("../src/custom/platform-config.js", import.meta.url),
  "utf8",
);
const fields = await readModule(
  new URL("../src/custom/control-fields.js", import.meta.url),
  "utf8",
);
const automatic = await readModule(
  new URL("../src/custom/automatic-fill.js", import.meta.url),
  "utf8",
);

test("scanner and fill observer have no host routing outside platform configuration", () => {
  assert(
    !/hostname|myworkdayjobs\.com|ashbyhq\.com|greenhouse\.io/.test(fields),
  );
  assert(
    !/hostname|myworkdayjobs\.com|ashbyhq\.com|greenhouse\.io/.test(automatic),
  );
});

test("platform capabilities require a real host boundary and retain old platform scope", () => {
  for (const [host, id] of [
    ["fixture.myworkdayjobs.com", "workday"],
    ["fixture.myworkdaysite.com", "workday"],
    ["careers.icims.com", "icims"],
    ["company.applytojob.com", "jazzhr"],
    ["company.theresumator.com", "jazzhr"],
    ["job-boards.eu.greenhouse.io", "greenhouse"],
    ["jobs.ashbyhq.com", "ashby"],
    ["company.breezy.hr", "breezy"],
    ["jobs.eu.lever.co", "lever"],
    ["www.tesla.com", "tesla"],
    ["jobs.ashbyhq.com.attacker.invalid", "generic"],
    ["fakegreenhouse.io", "generic"],
    ["myworkdayjobs.com.attacker.invalid", "generic"],
    ["noticims.com", "generic"],
    ["company.lever.co", "generic"],
    ["breezy.hr", "generic"],
  ]) {
    const dom = new JSDOM("<form></form>", {
      url: "https://" + host,
      runScripts: "outside-only",
    });
    try {
      dom.window.eval(platform);
      const result = dom.window.JobsPlatformConfig.detect(dom.window.document);
      assert.equal(result.id, id, host);
      assert(Object.isFrozen(result));
    } finally {
      dom.window.close();
    }
  }
});

test("a Workday-shaped date on an unrelated site remains independent generic controls", () => {
  const html =
    '<form><div data-automation-id="dateInputWrapper"><label>Date</label><input data-automation-id="dateSectionMonth-input" aria-label="Month"><input data-automation-id="dateSectionDay-input" aria-label="Day"><input data-automation-id="dateSectionYear-input" aria-label="Year"></div></form>';
  const dom = new JSDOM(html, {
    url: "https://example.invalid",
    runScripts: "outside-only",
  });
  try {
    dom.window.eval(platform + "\n" + fields);
    const rows = dom.window.JobsControlFields.create(
      dom.window.document,
    ).scan();
    assert.equal(rows.length, 3);
    assert(rows.every((row) => !row.dateParts));
  } finally {
    dom.window.close();
  }
});
