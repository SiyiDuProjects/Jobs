import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { withFixtureClock } from "./helpers/fixture-clock.mjs";

test("fixture clock preserves deadlines, cancellations and promise-created timers", async () => {
  const w = new JSDOM("<p></p>").window,
    original = w.setTimeout;
  try {
    const events = [];
    const elapsed = await withFixtureClock(w, async () => {
      const start = w.Date.now();
      const cancelled = w.setTimeout(() => events.push("cancelled"), 1);
      w.clearTimeout(cancelled);
      let repeats = 0;
      const interval = w.setInterval(() => {
        events.push("interval");
        if (++repeats === 2) w.clearInterval(interval);
      }, 10);
      await new Promise((resolve) => w.setTimeout(resolve, 30));
      events.push("deadline");
      await new Promise((resolve) => w.setTimeout(resolve, 5));
      return w.Date.now() - start;
    });
    assert.equal(elapsed, 35);
    assert.deepEqual(events, ["interval", "interval", "deadline"]);
    assert.equal(w.setTimeout, original);
  } finally {
    w.close();
  }
});

test("page mutations flush before a quiet-page deadline and failures restore the clock", async () => {
  const w = new JSDOM("<p></p>").window,
    NativeDate = w.Date;
  try {
    const result = await withFixtureClock(
      w,
      () =>
        new Promise((resolve) => {
          const observer = new w.MutationObserver(() => {
            observer.disconnect();
            resolve("committed");
          });
          observer.observe(w.document.body, { childList: true, subtree: true });
          w.setTimeout(() => resolve("deadline"), 1000);
          Promise.resolve().then(() => {
            w.document.querySelector("p").textContent = "Page answer";
          });
        }),
    );
    assert.equal(result, "committed");
    await assert.rejects(
      withFixtureClock(w, async () => {
        throw Error("Fixture failure");
      }),
      /Fixture failure/,
    );
    assert.equal(w.Date, NativeDate);
  } finally {
    w.close();
  }
});
