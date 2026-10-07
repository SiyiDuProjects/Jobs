import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import { readModule } from "./helpers/module-source.mjs";
import { chooseAnswer } from "./helpers/choose-answer.mjs";
const dom = new JSDOM('<div id="root"></div>', {
  url: "https://jobs.ashbyhq.com/fixture/application",
  runScripts: "outside-only",
});
const w = dom.window;
Object.assign(globalThis, {
  window: w,
  document: w.document,
  HTMLElement: w.HTMLElement,
});
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { flushSync } = await import("react-dom");
for (const file of [
  "dom-wait.js",
  "control-fields.js",
  "ashby-saved-controls.js",
])
  w.eval(
    await readWithDependencies(
      new URL("../src/custom/" + file, import.meta.url),
      "utf8",
    ),
  );
w.eval(
  await readModule(
    new URL("../src/custom/ashby-page-state.js", import.meta.url),
    "utf8",
  ),
);
const savedSource = await readWithDependencies(
  new URL("../src/custom/ashby-saved-controls.js", import.meta.url),
  "utf8",
);
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(read) {
  for (let i = 0; i < 100; i++) {
    if (read()) return;
    await pause();
  }
  assert.fail("condition did not become true");
}
function fixture(types = ["text", "text"]) {
  let pending = [],
    server = {},
    calls = [],
    reject = false,
    dateReceipt = null;
  const definition = {
    definitions: [
      { kind: "OperationDefinition", name: { value: "ApiSetFormValue" } },
    ],
  };
  w.eval(savedSource);
  const root = createRoot(w.document.getElementById("root"));
  w.chrome = {
    runtime: {
      sendMessage: async (m) => ({
        data: await w.readAshbyCommit(m.path, m.phase, 180),
      }),
    },
  };
  function Field({ field, savedValue, kind }) {
    const [draft, setDraft] = React.useState(savedValue ?? "");
    const [, render] = React.useState(0);
    const timer = React.useRef();
    const ref = React.useRef({
      mutation:
        kind === "file"
          ? {
              definitions: [
                {
                  kind: "OperationDefinition",
                  name: { value: "ApiSetFormValueToFile" },
                },
              ],
            }
          : definition,
      result: { called: false, loading: false },
    });
    const save = () => {
      if (draft === "" || draft === savedValue) return;
      ref.current.result = { called: true, loading: true };
      render((n) => n + 1);
      const dateParts =
        kind === "ashby-date" && draft.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      const stored = dateParts
        ? `${dateParts[3]}-${dateParts[1].padStart(2, "0")}-${dateParts[2].padStart(2, "0")}`
        : draft;
      const snapshot = { ...server, [field.path]: stored };
      calls.push(field.path);
      pending.push(() => {
        server = snapshot;
        ref.current.result = {
          called: true,
          loading: false,
          ...(reject
            ? { error: Error("fixture failure") }
            : {
                data: {
                  [kind === "file" ? "setFormValueToFile" : "setFormValue"]: {
                    id: "fixture-form",
                    sections: [
                      {
                        fieldEntries: types.map((_, i) => ({
                          id: "entry-" + i,
                          fieldValue:
                            server["field-" + i] === undefined
                              ? null
                              : types[i] === "file"
                                ? { filename: server["field-" + i] }
                                : {
                                    value:
                                      types[i] === "ashby-date"
                                        ? (dateReceipt ?? server["field-" + i])
                                        : server["field-" + i],
                                  },
                        })),
                      },
                    ],
                  },
                },
              }),
        };
        render((n) => n + 1);
      });
    };
    React.useEffect(() => {
      if (kind === "yesno" || kind === "file" || kind === "ashby-date") {
        save();
        return;
      }
      timer.current = setTimeout(save, 500);
      return () => clearTimeout(timer.current);
    }, [draft]);
    if (kind === "file")
      return React.createElement("input", {
        id: field.path,
        type: "file",
        disabled: ref.current.result.loading,
        onChange: (e) => setDraft(e.target.files[0]?.name || ""),
      });
    if (kind === "yesno")
      return React.createElement(
        "div",
        { className: "ashby-application-form-input-yesno" },
        ...["Yes", "No"].map((label) =>
          React.createElement(
            "button",
            {
              type: "button",
              "data-option": label.toLowerCase(),
              "aria-pressed": draft === (label === "Yes"),
              onClick: () => setDraft(label === "Yes"),
            },
            label,
          ),
        ),
      );
    return React.createElement(kind === "textarea" ? "textarea" : "input", {
      id: field.path,
      "aria-label": "Fixture " + field.path,
      type:
        kind === "textarea" ? undefined : kind === "ashby-date" ? "text" : kind,
      className:
        kind === "ashby-date" ? "ashby-application-form-input-date" : undefined,
      ...(kind === "textarea" ? { children: draft } : { value: draft }),
      onChange: (e) => setDraft(e.target.value),
      onBlur: () => {
        if (kind === "ashby-date") return;
        clearTimeout(timer.current);
        save();
      },
    });
  }
  flushSync(() =>
    root.render(
      React.createElement(
        "form",
        null,
        ...types.map((kind, i) =>
          React.createElement(
            "div",
            {
              "data-field-path": "field-" + i,
              "data-field-entry-id": "entry-" + i,
              className: "ashby-application-form-field-entry",
            },
            React.createElement(
              "label",
              {
                className: "ashby-application-form-question-title",
                htmlFor: "field-" + i,
              },
              "Fixture " + i,
            ),
            React.createElement(Field, {
              field: { path: "field-" + i },
              savedValue: undefined,
              ...(kind === "file" ? { savedFile: undefined } : {}),
              kind,
            }),
          ),
        ),
      ),
    ),
  );
  const nodes = types.map((kind, i) =>
    kind === "yesno"
      ? w.document.querySelector(
          `[data-field-path="field-${i}"] .ashby-application-form-input-yesno`,
        )
      : w.document.getElementById("field-" + i),
  );
  return {
    nodes,
    calls,
    pending,
    get server() {
      return server;
    },
    set dateReceipt(v) {
      dateReceipt = v;
    },
    set reject(v) {
      reject = v;
    },
    close() {
      flushSync(() => root.unmount());
      delete w[Symbol.for("jobs.ashby.save-observations.v1")];
    },
  };
}
test("text and textarea wait for server acknowledgement and serialize whole-form saves", async () => {
  const f = fixture(["email", "textarea"]);
  try {
    let ended = false;
    const first = chooseAnswer(f.nodes[0], "fixture@example.test").then((r) => {
      ended = true;
      return r;
    });
    await until(() => f.pending.length === 1);
    assert.equal(ended, false, "DOM value and started save are not a commit");
    f.pending.shift()();
    assert.ok(await first);
    const second = chooseAnswer(f.nodes[1], "Synthetic project");
    await until(() => f.pending.length === 1);
    assert.equal(f.server["field-0"], "fixture@example.test");
    f.pending.shift()();
    assert.ok(await second);
    assert.deepEqual(f.server, {
      "field-0": "fixture@example.test",
      "field-1": "Synthetic project",
    });
  } finally {
    f.close();
  }
});
test("Yes/No stays pending until saved; false is a real saved answer", async () => {
  const f = fixture(["yesno"]);
  try {
    const done = chooseAnswer(f.nodes[0], "No");
    await until(() => f.pending.length === 1);
    f.pending.shift()();
    assert.ok(await done);
    assert.equal(f.server["field-0"], false);
  } finally {
    f.close();
  }
});
test("failed save keeps visible answer but cannot count as a committed field", async () => {
  const f = fixture(["text"]);
  try {
    f.reject = true;
    const done = chooseAnswer(f.nodes[0], "Synthetic retained draft");
    await until(() => f.pending.length === 1);
    f.pending.shift()();
    assert.equal(await done, null);
    assert.equal(f.nodes[0].value, "Synthetic retained draft");
    const row = w.JobsControlFields.create(w.document, () =>
      w.document.querySelector("form"),
    ).scan()[0];
    assert.equal(row.public.commitState, "unconfirmed");
  } finally {
    f.close();
  }
});
test("a later whole-form response losing an acknowledged field is rejected, including old receipt rereads", async () => {
  const f = fixture(["text", "text"]);
  try {
    const a = chooseAnswer(f.nodes[0], "First fixture");
    await until(() => f.pending.length === 1);
    const b = w.JobsControlFields.writeText(f.nodes[1], "Second fixture");
    await until(() => f.pending.length === 2);
    f.pending.shift()();
    assert.ok(await a);
    f.pending.shift()();
    await b;
    assert.equal(await w.JobsAshbySavedControls.verify(f.nodes[1]), false);
    assert.equal(await w.JobsAshbySavedControls.verify(f.nodes[0]), false);
  } finally {
    f.close();
  }
});
test("missing page-state bridge refuses success without rewriting or clearing the draft", async () => {
  const f = fixture(["text"]);
  try {
    w.chrome.runtime.sendMessage = async () => {
      throw Error("unavailable");
    };
    assert.equal(await chooseAnswer(f.nodes[0], "Retained fixture"), null);
    assert.equal(f.nodes[0].value, "Retained fixture");
  } finally {
    f.close();
  }
});

test("concurrent extension writers wait in order rather than starting overlapping saves", async () => {
  const f = fixture();
  try {
    const a = chooseAnswer(f.nodes[0], "First");
    await until(() => f.pending.length === 1);
    const b = chooseAnswer(f.nodes[1], "Second");
    await pause();
    await pause();
    assert.equal(f.pending.length, 1);
    assert.equal(f.nodes[1].value, "");
    f.pending.shift()();
    assert.ok(await a);
    await until(() => f.pending.length === 1);
    f.pending.shift()();
    assert.ok(await b);
    assert.deepEqual(f.server, { "field-0": "First", "field-1": "Second" });
  } finally {
    f.close();
  }
});
test("a save timeout holds later writes without clearing or replaying the pending field", async () => {
  const f = fixture();
  try {
    assert.equal(await chooseAnswer(f.nodes[0], "Pending fixture"), null);
    assert.equal(await chooseAnswer(f.nodes[1], "Must not start"), null);
    assert.equal(f.pending.length, 1);
    assert.equal(f.nodes[1].value, "");
    f.pending.shift()();
    assert.equal(await w.JobsAshbySavedControls.verify(f.nodes[0]), true);
  } finally {
    f.close();
  }
});
test("user edit during acknowledgement is retained and the superseded write fails", async () => {
  const f = fixture(["text"]);
  try {
    const done = chooseAnswer(f.nodes[0], "Original fixture");
    await until(() => f.pending.length === 1);
    w.JobsControlFields.writeValue(f.nodes[0], "User correction");
    f.pending.shift()();
    assert.equal(await done, null);
    assert.equal(f.nodes[0].value, "User correction");
  } finally {
    f.close();
  }
});
test("changed private page structure is reported unsupported, never inferred as saved", async () => {
  const f = fixture(["text"]);
  try {
    await w.JobsControlFields.writeText(f.nodes[0], "Fixture");
    const entry = f.nodes[0].closest("[data-field-path]");
    delete entry[
      Object.keys(entry).find((key) => key.startsWith("__reactProps$"))
    ];
    const result = await w.readAshbyCommit("field-0", "saved", 0);
    assert.equal(result.state, "unsupported");
  } finally {
    f.close();
  }
});

test("resume save acknowledgement holds subsequent questions and retains the uploaded file", async () => {
  const f = fixture(["file", "text"]);
  try {
    const upload = w.JobsAshbySavedControls.upload(f.nodes[0], () => {
      Object.defineProperty(f.nodes[0], "files", {
        value: [new w.File(["synthetic"], "fixture.pdf")],
      });
      f.nodes[0].dispatchEvent(new w.Event("change", { bubbles: true }));
    });
    const answer = chooseAnswer(f.nodes[1], "Synthetic question");
    await until(() => f.pending.length === 1);
    assert.equal(f.nodes[1].value, "");
    f.pending.shift()();
    assert.equal(await upload, undefined);
    await until(() => f.pending.length === 1);
    f.pending.shift()();
    assert.ok(await answer);
    assert.deepEqual(f.server, {
      "field-0": "fixture.pdf",
      "field-1": "Synthetic question",
    });
  } finally {
    f.close();
  }
});
test("a rejected upload returns a hold and prevents subsequent writes", async () => {
  const f = fixture(["file", "text"]);
  try {
    f.reject = true;
    const upload = w.JobsAshbySavedControls.upload(f.nodes[0], () => {
      Object.defineProperty(f.nodes[0], "files", {
        value: [new w.File(["synthetic"], "fixture.pdf")],
      });
      f.nodes[0].dispatchEvent(new w.Event("change", { bubbles: true }));
    });
    await until(() => f.pending.length === 1);
    f.pending.shift()();
    assert.ok((await upload).hold);
    assert.equal(await chooseAnswer(f.nodes[1], "Must not start"), null);
    assert.equal(f.nodes[1].value, "");
    assert.equal(f.calls.length, 1);
  } finally {
    f.close();
  }
});

test("upload cannot reuse a prior receipt merely because the filename is the same", async () => {
  const f = fixture(["file"]);
  try {
    const first = w.JobsAshbySavedControls.upload(f.nodes[0], () => {
      Object.defineProperty(f.nodes[0], "files", {
        value: [new w.File(["synthetic"], "fixture.pdf")],
      });
      f.nodes[0].dispatchEvent(new w.Event("change", { bubbles: true }));
    });
    await until(() => f.pending.length === 1);
    f.pending.shift()();
    assert.equal(await first, undefined);
    // The page has accepted an earlier file, but this attempt gets no new save.
    assert.ok(
      (await w.JobsAshbySavedControls.upload(f.nodes[0], () => {})).hold,
    );
    assert.equal(f.calls.length, 1);
  } finally {
    f.close();
  }
});

test("a delayed pre-blur check waits for an already-started debounce save", async () => {
  const f = fixture(["text"]);
  try {
    w.JobsControlFields.writeValue(f.nodes[0], "Synthetic delayed draft");
    // Start the existing page save through a natural blur in the fixture.
    f.nodes[0].focus();
    f.nodes[0].blur();
    // React may render between the input event and blur; the debounce then saves.
    for (let i = 0; !f.pending.length && i < 150; i++) await pause();
    assert.equal(f.pending.length, 1);
    let ended = false;
    const draft = w.readAshbyCommit("field-0", "draft", 800).then((r) => {
      ended = true;
      return r;
    });
    await pause();
    assert.equal(ended, false);
    f.pending.shift()();
    assert.equal((await draft).state, "confirmed");
  } finally {
    f.close();
  }
});

test("Ashby calendar acknowledges a US display against its ISO date receipt and retains it in later saves", async () => {
  const f = fixture(["ashby-date", "text"]);
  try {
    const done = chooseAnswer(f.nodes[0], "9/2/2032");
    await until(() => f.pending.length === 1);
    f.pending.shift()();
    assert.ok(
      await done,
      "the saved calendar day must match across display/storage formats",
    );
    assert.equal(
      f.nodes[0].value,
      "9/2/2032",
      "verification must not rewrite the display",
    );
    const next = chooseAnswer(f.nodes[1], "Synthetic answer");
    await until(() => f.pending.length === 1);
    f.pending.shift()();
    assert.ok(await next);
    assert.equal(await w.JobsAshbySavedControls.verify(f.nodes[0]), true);
    assert.equal(f.server["field-0"], "2032-09-02");
  } finally {
    f.close();
  }
});

test("a different saved calendar day remains unconfirmed and blocks later writes", async () => {
  const f = fixture(["ashby-date", "text"]);
  try {
    f.dateReceipt = "2032-09-03";
    const done = chooseAnswer(f.nodes[0], "09/02/2032");
    await until(() => f.pending.length === 1);
    f.pending.shift()();
    assert.equal(await done, null);
    assert.equal(await chooseAnswer(f.nodes[1], "Must not start"), null);
    assert.equal(f.nodes[1].value, "");
  } finally {
    f.close();
  }
});
test("invalid or partial calendar drafts never become confirmed dates", async () => {
  const f = fixture(["ashby-date"]);
  try {
    for (const value of ["02/29/2031", "02/30/2032", "13/01/2032", "12/2032"]) {
      w.JobsControlFields.writeValue(f.nodes[0], value);
      assert.equal(
        (await w.readAshbyCommit("field-0", "saved", 0)).state,
        "invalid-date",
      );
    }
  } finally {
    f.close();
  }
});
