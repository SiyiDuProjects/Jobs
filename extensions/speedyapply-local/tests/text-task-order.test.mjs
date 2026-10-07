import test from "node:test";
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";

const source = await readWithDependencies(
  new URL("../src/custom/control-fields.js", import.meta.url),
  "utf8",
);
function fixture(t) {
  const dom = new JSDOM('<input id="phone" type="tel"><input id="next">', {
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.scheduler = {
    postTask: (callback, options) => {
      assert.equal(options.priority, "background");
      return new Promise((resolve) => pageTask(() => resolve(callback())));
    },
  };
  w.eval(source);
  assert.equal(w.document.hidden, true);
  // Hidden-page timers and animation frames never run in this fixture.
  w.setTimeout = () => 1;
  w.requestAnimationFrame = () => 1;
  return { w, phone: w.document.getElementById("phone") };
}
function pageTask(callback) {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    channel.port2.close();
    callback();
  };
  channel.port2.postMessage(null);
}

test(
  "background text commits in page order with every timer suspended",
  { timeout: 2000 },
  async (t) => {
    const { w, phone } = fixture(t);
    const next = w.document.getElementById("next");
    const committed = [];
    for (const node of [phone, next]) {
      let rendered = "";
      node.addEventListener("input", () => {
        const value = node.value;
        pageTask(() => {
          rendered = value;
        });
      });
      node.addEventListener("focusout", () => {
        committed.push(rendered);
      });
    }
    assert.equal(await w.JobsControlFields.writeText(phone, "5550100"), phone);
    assert.equal(await w.JobsControlFields.writeText(next, "Fixture"), next);
    assert.deepEqual(committed, ["5550100", "Fixture"]);
  },
);

test(
  "pause during the page task prevents a later blur",
  { timeout: 2000 },
  async (t) => {
    const { w, phone } = fixture(t);
    let live = true,
      blurred = false;
    phone.addEventListener("input", () =>
      pageTask(() => {
        live = false;
      }),
    );
    phone.addEventListener("focusout", () => {
      blurred = true;
    });
    assert.equal(
      await w.JobsControlFields.writeText(phone, "5550100", {
        canProceed: () => live,
      }),
      null,
    );
    assert.equal(blurred, false);
  },
);

test(
  "a field replaced during rendering is not reported committed",
  { timeout: 2000 },
  async (t) => {
    const { w, phone } = fixture(t);
    phone.addEventListener("input", () => pageTask(() => phone.remove()));
    assert.equal(await w.JobsControlFields.writeText(phone, "5550100"), null);
  },
);

test(
  "page rejection after blur is observed before the writer returns",
  { timeout: 2000 },
  async (t) => {
    const { w, phone } = fixture(t);
    phone.addEventListener("focusout", () =>
      pageTask(() => {
        phone.value = "";
      }),
    );
    assert.equal(await w.JobsControlFields.writeText(phone, "5550100"), null);
  },
);

test(
  "input-only writes still let their component own commit acknowledgement",
  { timeout: 2000 },
  async (t) => {
    const { w, phone } = fixture(t);
    let blurred = false;
    phone.addEventListener("focusout", () => {
      blurred = true;
    });
    assert.equal(
      await w.JobsControlFields.writeText(phone, "5550100", {
        blur: false,
        waitForRender: false,
      }),
      phone,
    );
    assert.equal(blurred, false);
  },
);
