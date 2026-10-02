import { build } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const bundle = (
  await build({
    entryPoints: [
      fileURLToPath(new URL("../../src/custom/popup.jsx", import.meta.url)),
    ],
    bundle: true,
    write: false,
    format: "iife",
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
  })
).outputFiles[0].text;
export async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(check(), "Popup did not reach the expected state");
}
export function popupPage(sendMessage, local = {}) {
  const errors = [],
    console = new VirtualConsole();
  console.on("jsdomError", (error) => errors.push(error.message));
  console.on("error", (error) => errors.push(String(error)));
  const w = new JSDOM('<div id="root"></div>', {
    url: "https://popup.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: console,
  }).window;
  const event = () => {
    const handlers = new Set();
    return {
      addListener: (fn) => handlers.add(fn),
      removeListener: (fn) => handlers.delete(fn),
      emit: (...args) => handlers.forEach((fn) => fn(...args)),
    };
  };
  const changed = event(),
    activated = event(),
    updated = event();
  let tab = {
    id: 12,
    url: "https://example.wd5.myworkdayjobs.com/job/Engineer_R123",
    title: "Fixture role",
  };
  w.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  w.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  w.CSS = { escape: (value) => String(value), supports: () => false };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLElement.prototype.getAnimations = () => [];
  w.chrome = {
    runtime: { sendMessage },
    storage: { onChanged: changed, local },
    tabs: {
      query: async () => [tab],
      onActivated: activated,
      onUpdated: updated,
    },
  };
  w.eval(bundle);
  return {
    w,
    errors,
    changed,
    activate(next) {
      tab = next;
      activated.emit({ tabId: next.id });
    },
    close: () => w.close(),
  };
}
