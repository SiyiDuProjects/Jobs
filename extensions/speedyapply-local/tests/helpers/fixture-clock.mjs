import { setImmediate as yieldTurn } from "node:timers/promises";

// Advance only this JSDOM window's clock. Give host work, promise continuations
// and MutationObservers a real turn before each scheduled timer, preserving
// page commits and cancellation instead of shortening production deadlines.
export async function withFixtureClock(
  w,
  operation,
  { maxElapsed = 120000 } = {},
) {
  const original = Object.fromEntries(
    ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"].map(
      (key) => [key, w[key]],
    ),
  );
  const epoch = original.Date.now(),
    timers = new Map();
  let elapsed = 0,
    sequence = 0;
  class FixtureDate extends original.Date {
    constructor(...args) {
      super(...(args.length ? args : [epoch + elapsed]));
    }
    static now() {
      return epoch + elapsed;
    }
  }
  w.Date = FixtureDate;
  const schedule = (callback, delay, repeat, args) => {
    const id = ++sequence,
      duration = Math.max(repeat ? 1 : 0, Number(delay) || 0);
    timers.set(id, {
      id,
      at: elapsed + duration,
      callback,
      args,
      repeat,
      duration,
    });
    return id;
  };
  w.setTimeout = (callback, delay, ...args) =>
    schedule(callback, delay, false, args);
  w.setInterval = (callback, delay, ...args) =>
    schedule(callback, delay, true, args);
  w.clearTimeout = w.clearInterval = (id) => {
    timers.delete(id);
  };
  let settled = false,
    failed = false,
    value,
    error;
  Promise.resolve()
    .then(operation)
    .then(
      (result) => {
        value = result;
        settled = true;
      },
      (reason) => {
        error = reason;
        failed = true;
        settled = true;
      },
    );
  try {
    let idle = 0;
    while (!settled) {
      await yieldTurn();
      if (settled) break;
      const timer = [...timers.values()].sort(
        (a, b) => a.at - b.at || a.id - b.id,
      )[0];
      if (!timer) {
        if (++idle > 100)
          throw Error(
            "Fixture is waiting on work outside its controlled window clock",
          );
        continue;
      }
      idle = 0;
      if (timer.at > maxElapsed)
        throw Error(`Fixture exceeded ${maxElapsed} ms of virtual time`);
      elapsed = timer.at;
      if (timer.repeat) timer.at += timer.duration;
      else timers.delete(timer.id);
      if (typeof timer.callback !== "function")
        throw Error("Fixture timers require a function");
      timer.callback(...timer.args);
    }
    if (failed) throw error;
    return value;
  } finally {
    timers.clear();
    Object.assign(w, original);
  }
}
