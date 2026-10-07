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
  responseDelay = 20,
  unmarked = false,
  commitDelay = 0,
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
    if (!unmarked)
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
      const commit = () => {
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
      option.querySelector("input").onclick = () =>
        commitDelay ? w.setTimeout(commit, commitDelay) : commit();
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
    }, responseDelay);
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

test("Skills accepts explicit language catalog names without broad substring matches", async () => {
  const h = fixture({ labels: (query) => [query + " (Programming Language)"] });
  try {
    await h.w.workdayFillSkills(["Python", "Java"]);
    assert.deepEqual(h.values(), [
      "Python (Programming Language)",
      "Java (Programming Language)",
    ]);
  } finally {
    h.close();
  }
});

test("unmatched search results remain available to the diagnostic trace", async () => {
  const h = fixture({ labels: ["JavaScript"] }),
    traces = [];
  h.w.JobsDiagnostics = {
    note() {},
    trace: (_node, entry) => traces.push(entry),
  };
  try {
    assert.equal(await h.choose("Java"), null);
    const failed = traces.find((entry) => entry.source === "binding:prompt");
    assert.equal(failed.result, "no-matching-option");
    assert.deepEqual(Array.from(failed.options), ["JavaScript"]);
  } finally {
    h.close();
  }
});

test("a pending background search can finish after its first deadline without another Enter", async () => {
  const h = fixture({ labels: ["SQL"], responseDelay: 240 });
  try {
    assert.equal(h.w.document.hidden, true);
    assert(await h.choose("SQL"));
    assert.deepEqual(h.values(), ["SQL"]);
    assert.deepEqual(
      h.trace.filter((item) => item.startsWith("search:")),
      ["search:SQL"],
    );
  } finally {
    h.close();
  }
});

test("Skills recovery retries an earlier failure once after a later selection succeeds", async () => {
  let attempts = 0;
  const h = fixture({
    labels: (query) =>
      query === "Python" && ++attempts === 1 ? ["Unrelated skill"] : [query],
  });
  try {
    await h.w.workdayFillSkills(["Python", "SQL"]);
    assert.deepEqual(h.values(), ["SQL", "Python"]);
    assert.deepEqual(
      h.trace.filter((item) => item.startsWith("search:")),
      ["search:Python", "search:SQL", "search:Python"],
    );
  } finally {
    h.close();
  }
});

test("prompt writes do not depend on zero-delay timers in background tabs", async () => {
  const h = fixture({ labels: ["SQL"] });
  const original = h.w.setTimeout.bind(h.w);
  h.w.setTimeout = (callback, delay, ...args) =>
    delay === 0 ? 0 : original(callback, delay, ...args);
  try {
    const result = await Promise.race([
      h.choose("SQL"),
      new Promise((resolve) => setTimeout(() => resolve(null), 600)),
    ]);
    assert(
      result,
      "an input-only write must reach the observed search response with zero-delay timers paused",
    );
    assert.deepEqual(h.values(), ["SQL"]);
  } finally {
    h.close();
  }
});

test("each new virtual search window gets a response wait instead of sharing the first deadline", async () => {
  const h = fixture({ labels: ["Unrelated 0"] });
  let window = 0;
  const observer = new h.w.MutationObserver(() => {
    const list = h.w.document.querySelector(
      '[data-uxi-multiselectlist-issearch="true"] [data-automation-id="activeListContainer"]',
    );
    if (!list || list.dataset.virtualFixture) return;
    list.dataset.virtualFixture = "true";
    Object.defineProperties(list, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 500 },
    });
    list.addEventListener("scroll", () =>
      h.w.setTimeout(() => {
        window++;
        const option = list.querySelector('[role="option"]');
        option.lastElementChild.textContent =
          window === 4 ? "SQL" : "Unrelated " + window;
        option.id = "window-" + window;
        option.querySelector("input").onclick = () => {
          h.w.document.querySelector("ul").innerHTML =
            '<li data-automation-id="menuItem"><div data-automation-id="selectedItem"><p>SQL</p></div></li>';
        };
      }, 60),
    );
  });
  observer.observe(h.w.document.body, { subtree: true, childList: true });
  try {
    assert(await h.choose("SQL"));
    assert.deepEqual(h.values(), ["SQL"]);
  } finally {
    observer.disconnect();
    h.close();
  }
});

test("an unmarked old nonmatching list does not end a pending search", async () => {
  const h = fixture({ unmarked: true, labels: ["SQL"] });
  try {
    assert(await h.choose("SQL"));
    assert.deepEqual(h.values(), ["SQL"]);
  } finally {
    h.close();
  }
});

test("a reused virtual list is rewound before searching its later windows", async () => {
  const h = fixture({ labels: ["Unrelated bottom result"] });
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
    list.scrollTop = 300;
    list.addEventListener("scroll", () => {
      if (list.scrollTop !== 0) return;
      h.w.queueMicrotask(() => {
        const option = list.querySelector('[role="option"]');
        option.lastElementChild.textContent = "SQL";
        option.querySelector("input").onclick = () => {
          h.w.document.querySelector("ul").innerHTML =
            '<li data-automation-id="menuItem"><div data-automation-id="selectedItem"><p>SQL</p></div></li>';
        };
      });
    });
  });
  observer.observe(h.w.document.body, { subtree: true, childList: true });
  try {
    assert(await h.choose("SQL"));
    assert.deepEqual(h.values(), ["SQL"]);
  } finally {
    observer.disconnect();
    h.close();
  }
});

test("returning to a hidden search allows its pending response to settle without replay", async () => {
  const h = fixture({ labels: ["SQL"], responseDelay: 260 });
  try {
    h.w.setTimeout(() => {
      Object.defineProperty(h.w.document, "hidden", {
        value: false,
        configurable: true,
      });
      h.w.document.dispatchEvent(new h.w.Event("visibilitychange"));
    }, 220);
    assert(await h.choose("SQL"));
    assert.equal(h.trace.filter((item) => item === "search:SQL").length, 1);
  } finally {
    h.close();
  }
});

test("cancellation during a deferred search preserves a manual value and never selects", async () => {
  const h = fixture({ labels: ["SQL"], responseDelay: 280 });
  let live = true;
  try {
    h.w.setTimeout(() => {
      live = false;
      h.input.value = "Manual query";
      h.w.document.dispatchEvent(new h.w.Event("visibilitychange"));
    }, 220);
    assert.equal(
      await chooseAnswer(h.input, "SQL", { canProceed: () => live }),
      null,
    );
    assert.equal(h.input.value, "Manual query");
    assert.deepEqual(h.values(), []);
    assert.equal(
      h.trace.filter((item) => item.startsWith("selected:")).length,
      0,
    );
  } finally {
    h.close();
  }
});

test("background deferral is bounded when the site never responds", async () => {
  const h = fixture({ labels: ["SQL"], responseDelay: 100000 });
  try {
    const began = Date.now();
    assert.equal(await h.choose("SQL"), null);
    assert(Date.now() - began < 1200);
    assert.equal(h.trace.filter((item) => item === "search:SQL").length, 1);
    assert.deepEqual(h.values(), []);
  } finally {
    h.close();
  }
});

test("a persistent absent skill receives at most one recovery and keeps committed skills", async () => {
  const h = fixture({
    labels: (query) => (query === "Java" ? ["JavaScript"] : [query]),
  });
  try {
    assert.equal(await h.w.workdayFillSkills(["Java", "SQL", "SQL"]), null);
    assert.deepEqual(h.values(), ["SQL"]);
    assert.deepEqual(
      h.trace.filter((item) => item.startsWith("search:")),
      ["search:Java", "search:SQL", "search:Java"],
    );
  } finally {
    h.close();
  }
});

test("foregrounding before the hidden search deadline still grants a foreground response window", async () => {
  const h = fixture({ labels: ["SQL"], responseDelay: 260 });
  try {
    h.w.setTimeout(() => {
      Object.defineProperty(h.w.document, "hidden", {
        value: false,
        configurable: true,
      });
      h.w.document.dispatchEvent(new h.w.Event("visibilitychange"));
    }, 80);
    assert(await h.choose("SQL"));
    assert.deepEqual(h.values(), ["SQL"]);
    assert.equal(h.trace.filter((item) => item === "search:SQL").length, 1);
  } finally {
    h.close();
  }
});

test("a delayed selected pill is observed without replaying the option click", async () => {
  const h = fixture({ labels: ["SQL"], commitDelay: 240 });
  let clicks = 0;
  h.w.document.addEventListener("click", (event) => {
    if (event.target.matches('input[type="checkbox"]')) clicks++;
  });
  try {
    assert(await h.choose("SQL"));
    assert.deepEqual(h.values(), ["SQL"]);
    assert.equal(clicks, 1);
  } finally {
    h.close();
  }
});

test("failed prompt cleanup also progresses when zero-delay timers are paused", async () => {
  let attempts = 0;
  const h = fixture({
    labels: (query) =>
      query === "Python" && ++attempts === 1 ? ["Unrelated skill"] : [query],
  });
  const original = h.w.setTimeout.bind(h.w);
  h.w.setTimeout = (callback, delay, ...args) =>
    delay === 0 ? 0 : original(callback, delay, ...args);
  try {
    const result = await Promise.race([
      h.w.workdayFillSkills(["Python", "SQL"]),
      new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);
    assert(
      result,
      "failed query cleanup must not prevent a later successful item or recovery",
    );
    assert.deepEqual(h.values(), ["SQL", "Python"]);
  } finally {
    h.close();
  }
});

test("candidate evidence from a recycled virtual row cannot authorize its new label", async () => {
  const h = fixture({ labels: ["SQL"] });
  let clicks = 0;
  const observer = new h.w.MutationObserver(() => {
    const list = h.w.document.querySelector(
      '[data-uxi-multiselectlist-issearch="true"] [data-automation-id="activeListContainer"]',
    );
    if (!list || list.dataset.virtualFixture) return;
    list.dataset.virtualFixture = "true";
    Object.defineProperties(list, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 180 },
    });
    list.addEventListener("scroll", () =>
      h.w.queueMicrotask(() => {
        const option = list.querySelector('[role="option"]');
        option.lastElementChild.textContent = "Python";
        option.querySelector("input").onclick = () => clicks++;
      }),
    );
  });
  observer.observe(h.w.document.body, { subtree: true, childList: true });
  try {
    assert.equal(
      await h.choose({
        tiers: [["SQL"]],
        select: (labels) =>
          labels.includes("SQL") && labels.includes("Python") ? "SQL" : null,
      }),
      null,
    );
    assert.equal(clicks, 0);
    assert.deepEqual(h.values(), []);
  } finally {
    observer.disconnect();
    h.close();
  }
});
