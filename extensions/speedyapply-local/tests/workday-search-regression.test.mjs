import { chooseAnswer } from "./helpers/choose-answer.mjs";
import { readModule, functionBlock } from "./helpers/module-source.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";

const current = await readModule(
  new URL("../source/content/adapters/workday.js", import.meta.url),
  "utf8",
);
const modules = await Promise.all(
  [
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
    "workday-controls",
  ].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
const block = functionBlock;
function fixture({
  major = false,
  delayedShell = false,
  resetOnOpen = false,
  stale = false,
  labels = ["Python Programming", "Python Scripting"],
} = {}) {
  const dom = new JSDOM(
    '<div id="field" data-automation-id="formField-' +
      (major ? "fieldOfStudy" : "skills") +
      '"><label>Question</label><div data-automation-id="multiSelectContainer"><input data-uxi-widget-type="selectinput" data-uxi-multiselect-id="prompt"><ul data-automation-id="selectedItemList"></ul></div></div>',
    {
      url: "https://fixture.myworkdayjobs.com/apply",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    doc = w.document,
    input = doc.querySelector("input"),
    trace = [],
    timeouts = [];
  modules.forEach((code) => w.eval(code));
  const until = w.JobsDOMWait.until;
  w.JobsDOMWait.until = async (read, options = {}) => {
    const result = await until(read, { ...options, timeout: 180 });
    if (result === null) timeouts.push(options.timeout ?? "unbounded");
    return result;
  };
  // The fixture supplies only the website response; the prompt is written
  // through the binding the adapters declare.
  w.eval(block(current, "workdayFillSkills"));
  let host;
  function list(names, isSearch, fresh) {
    const group = doc.createElement("div");
    group.setAttribute("data-uxi-multiselectlist-issearch", String(isSearch));
    group.innerHTML =
      '<div data-automation-id="activeListContainer"><div role="presentation"></div></div>';
    const presentation = group.querySelector('[role="presentation"]');
    for (const name of names) {
      const option = doc.createElement("div");
      option.setAttribute("role", "option");
      option.innerHTML =
        '<div><input type="' +
        (major ? "radio" : "checkbox") +
        '"></div><div data-automation-id="promptOption"></div>';
      option.lastElementChild.textContent = name;
      option.querySelector("input").onclick = () => {
        trace.push((fresh ? "selected:" : "stale:") + name);
        if (!fresh) return;
        const pill = doc.createElement("li");
        pill.setAttribute("data-automation-id", "menuItem");
        pill.innerHTML =
          '<div data-automation-id="selectedItem"><p data-automation-id="promptOption"></p></div>';
        pill.querySelector("p").textContent = name;
        if (major) doc.querySelector("ul").replaceChildren(pill);
        else doc.querySelector("ul").append(pill);
        input.value = "";
        host.remove();
      };
      presentation.append(option);
    }
    return group;
  }
  input.onclick = () => {
    if (host?.isConnected) return;
    host = doc.createElement("div");
    host.setAttribute("data-associated-widget", "prompt");
    host.setAttribute("data-automation-id", "responsiveMonikerPrompt");
    doc.body.append(host);
    if (resetOnOpen === "early")
      w.setTimeout(() => {
        input.value = "";
      }, 0);
    if (delayedShell) {
      host.setAttribute("aria-busy", "true");
      w.setTimeout(() => {
        if (resetOnOpen) input.value = "";
        host.removeAttribute("aria-busy");
        host.append(list(["Accounting"], false, false));
        trace.push("list-ready");
      }, 25);
    } else host.append(list(stale ? labels : ["Accounting"], stale, false));
  };
  input.onkeydown = (event) => {
    if (event.key === "Escape") {
      host?.remove();
      return;
    }
    if (event.key !== "Enter") return;
    if (!host?.querySelector('[role="presentation"]')) {
      trace.push("early-enter");
      return;
    }
    trace.push("search:" + input.value);
    const results = typeof labels === "function" ? labels(input.value) : labels;
    const destination = host;
    w.setTimeout(() => {
      if (destination.isConnected) {
        destination.replaceChildren(list(results, true, true));
        trace.push("results-ready");
      }
    }, 20);
  };
  const choose = (answer) =>
    w.JobsFormPipeline.bind([
      {
        name: "prompt",
        find: () => input,
        answer:
          typeof answer === "object"
            ? answer
            : w.JobsProfileAnswers.literalSpec("known-answer", answer),
      },
    ]).then((results) => results[0]);
  return {
    w,
    input,
    trace,
    timeouts,
    choose,
    values: () => [...doc.querySelectorAll("ul p")].map((n) => n.textContent),
    close: () => w.close(),
  };
}

test("the major binding waits for the inner list, not the responsive loading shell", async () => {
  {
    const h = fixture({
      major: true,
      delayedShell: true,
      labels: ["Applied Physics", "Physics"],
    });
    try {
      const result = await h.choose("Physics");
      assert(result, "must commit the major: " + h.trace.join(","));
      assert.deepEqual(h.values(), ["Physics"]);
      assert(!h.trace.includes("early-enter"));
    } finally {
      h.close();
    }
  }
});

test("responsive single-select can reset its search input while mounting; Physics is written after readiness", async () => {
  for (const resetOnOpen of [true, "early"]) {
    const h = fixture({
      major: true,
      delayedShell: true,
      resetOnOpen,
      labels: (query) =>
        query === "Physics"
          ? [
              "Applied Physics",
              "Chemical Physics",
              "Engineering Physics",
              "Physical Education",
              "Physical Therapy",
              "Physics",
            ]
          : ["Accounting"],
    });
    try {
      assert(await h.choose("Physics"), h.trace.join(","));
      assert.deepEqual(h.values(), ["Physics"]);
      assert.deepEqual(
        h.trace.filter((item) => item.startsWith("search:")),
        ["search:Physics"],
        "One search: the rule picks from the fresh response and it is committed without searching again",
      );
    } finally {
      h.close();
    }
  }
});

test("known programming skill uses shared equivalents without an unrelated first result", async () => {
  {
    const h = fixture();
    try {
      assert(
        await h.choose(h.w.JobsProfileAnswers.skillSpec("Python")),
        "must commit the confirmed programming skill",
      );
      assert.deepEqual(h.values(), ["Python Programming"]);
      assert.deepEqual(h.timeouts, [], "must react to results immediately");
    } finally {
      h.close();
    }
  }
});

test("the Skills binding waits for this search response before clicking a stale exact result", async () => {
  {
    const h = fixture({ stale: true, labels: ["SQL"] });
    try {
      assert(
        await h.choose("SQL"),
        "must wait for the replacement results: " + h.trace.join(","),
      );
      assert.deepEqual(h.values(), ["SQL"]);
      assert(!h.trace.some((item) => item.startsWith("stale:")));
      assert.deepEqual(h.timeouts, []);
    } finally {
      h.close();
    }
  }
});

test("the actual Skills loop preserves appended pills across consecutive exact and containing searches", async () => {
  {
    const h = fixture({
      labels: (query) =>
        query === "Python"
          ? ["Python Programming", "Python Scripting"]
          : ["SQL"],
    });
    try {
      await h.w.workdayFillSkills(["Python", "SQL", "Python"]);
      assert.deepEqual(h.values(), ["Python Programming", "SQL"]);
      assert.deepEqual(
        h.trace.filter((item) => item.startsWith("search:")),
        ["search:Python", "search:SQL"],
        "must not repeat an already committed skill",
      );
      assert.deepEqual(h.timeouts, []);
    } finally {
      h.close();
    }
  }
});

test("the actual Skills loop does not mistake an existing JavaScript pill for Java", async () => {
  const h = fixture({ labels: (query) => [query] });
  try {
    await h.w.workdayFillSkills(["JavaScript", "Java", "Java"]);
    assert.deepEqual(h.values(), ["JavaScript", "Java"]);
    assert.equal(h.trace.filter((item) => item === "selected:Java").length, 1);
  } finally {
    h.close();
  }
});

test("shared prompt cancels during popup loading without selecting or navigating", async () => {
  const h = fixture({ major: true, delayedShell: true, labels: ["Physics"] });
  try {
    let active = true;
    const result = chooseAnswer(h.input, "Physics", {
      canProceed: () => active,
    });
    active = false;
    assert.equal(await result, null);
    assert.deepEqual(h.values(), []);
    assert(!h.trace.some((item) => item.startsWith("selected:")));
  } finally {
    h.close();
  }
});

test("an unrelated Workday search result cannot become a claimed skill", async () => {
  const h = fixture({ labels: ["New Hire Sales Training"] });
  try {
    assert.equal(await h.choose("Hive"), null);
    assert.deepEqual(h.values(), []);
  } finally {
    h.close();
  }
});

test("Java cannot be substituted with JavaScript when only a substring matches", async () => {
  const h = fixture({ labels: ["JavaScript"] });
  try {
    assert.equal(await h.choose("Java"), null);
    assert.deepEqual(h.values(), []);
  } finally {
    h.close();
  }
});

test("Physics is found after a virtual result list mounts its later window", async () => {
  const h = fixture({
    major: true,
    labels: ["Applied Physics", "Chemical Physics"],
  });
  try {
    const observer = new h.w.MutationObserver(() => {
      const list = h.w.document.querySelector(
        '[data-uxi-multiselectlist-issearch="true"] [data-automation-id="activeListContainer"]',
      );
      if (!list || list.dataset.virtualFixture) return;
      list.dataset.virtualFixture = "true";
      Object.defineProperties(list, {
        clientHeight: { value: 100 },
        scrollHeight: { value: 400 },
      });
      list.addEventListener(
        "scroll",
        () => {
          h.w.setTimeout(() => {
            const option = list.querySelector('[role="option"]');
            option.lastElementChild.textContent = "Physics";
            option.id = "physics-late";
            option.setAttribute("aria-posinset", "22");
            option.querySelector("input").onclick = () => {
              h.w.document.querySelector("ul").innerHTML =
                '<li data-automation-id="menuItem"><div data-automation-id="selectedItem"><p data-automation-id="promptOption">Physics</p></div></li>';
            };
          }, 5);
        },
        { once: true },
      );
    });
    observer.observe(h.w.document.body, { subtree: true, childList: true });
    try {
      assert(await h.choose("Physics"));
      assert.deepEqual(h.values(), ["Physics"]);
    } finally {
      observer.disconnect();
    }
  } finally {
    h.close();
  }
});
