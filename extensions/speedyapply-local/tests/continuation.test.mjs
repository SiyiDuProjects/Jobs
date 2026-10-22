import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { continuation } from "../src/custom/continuation.js";

test("lightweight presenter recognition retains the scanner's continuation and exclusion behavior", () => {
  const w = new JSDOM("<body></body>").window;
  try {
    for (const [markup, expected] of [
      ["<button>Save and Continue</button>", true],
      ["<button><span>Next step</span></button>", true],
      ['<input type="submit" value="Submit application">', true],
      ['<div role="button" aria-label="继续"></div>', true],
      ["<button disabled>Submit</button>", false],
      ["<button>Continue later</button>", false],
      ["<button>Previous</button>", false],
      ['<button role="radio">Apply</button>', false],
      ['<button role="checkbox">Apply</button>', false],
      ["<button>Save draft</button>", false],
    ]) {
      w.document.body.innerHTML = markup;
      const target =
        w.document.querySelector("span") || w.document.body.firstElementChild;
      assert.equal(Boolean(continuation(target)), expected, markup);
    }
    assert.equal(continuation(null), null);
  } finally {
    w.close();
  }
});
