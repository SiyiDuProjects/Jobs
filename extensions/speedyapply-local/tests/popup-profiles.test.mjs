import test from "node:test";
import assert from "node:assert/strict";
import { popupPage, until } from "./helpers/popup-page.mjs";

test("unbound pages display the default without claiming an active binding", async () => {
  const h = popupPage(async (msg) =>
    msg.type === "jobs:popup-profile"
      ? {
          data: {
            available: true,
            bound: false,
            kind: "intern",
            profileName: "Intern",
            source: "manual",
            choices: { intern: true, newgrad: true },
          },
        }
      : { error: "当前页面无法识别岗位" },
  );
  try {
    await until(() =>
      h.w.document.body.textContent.includes("本页：实习（Intern）"),
    );
    assert(!h.w.document.body.textContent.includes("默认档案"));
    assert(
      h.w.document
        .getElementById("jobs-profile-hint")
        .textContent.includes("此页面尚未绑定资料"),
    );
  } finally {
    h.close();
  }
});

test("HeroUI popup reflects tab Profile changes and manual selection", async () => {
  let current = {
    available: true,
    kind: "newgrad",
    profileName: "Newgrad",
    source: "automatic",
    url: "https://jobs.example/",
    choices: { intern: true, newgrad: true },
  };
  const actions = [];
  const h = popupPage(async (msg) => {
    actions.push(msg);
    if (msg.type === "jobs:job-action")
      return { error: "当前页面无法识别岗位" };
    if (msg.action === "select")
      current = {
        ...current,
        kind: msg.kind,
        profileName: "Intern",
        source: "manual",
      };
    return { data: structuredClone(current) };
  });
  const kindVisible = (kind) =>
    h.w.document.body.textContent.includes(
      kind === "intern" ? "本页：实习（Intern）" : "本页：全职（Newgrad）",
    );
  const correction = () =>
    [...h.w.document.querySelectorAll("button")].find((button) =>
      button.textContent.startsWith("改为"),
    );
  try {
    await until(() => kindVisible("newgrad"));
    correction().click();
    await until(() => kindVisible("intern"));
    h.activate({
      id: 2,
      url: "https://jobs.example/",
      title: "Second fixture",
    });
    await until(
      () =>
        kindVisible("intern") &&
        actions.some((a) => a.action === "read" && a.tabId === 2),
    );
    current = {
      ...current,
      kind: "newgrad",
      profileName: "Newgrad",
      source: "automatic",
    };
    h.changed.emit({ jobsKindProfiles: {} }, "local");
    await until(() => kindVisible("newgrad"));
    assert.equal(actions.filter((a) => a.action === "select").length, 1);
    assert.equal(h.w.document.querySelector("textarea"), null);
    assert(!h.w.document.body.textContent.includes("投递队列"));
    assert.deepEqual(h.errors, []);
  } finally {
    h.close();
  }
});
