import test from "node:test";
import assert from "node:assert/strict";
import { checkSourceSize } from "../scripts/check-source-size.mjs";
test("page run and canonical scanner stay within reviewed responsibility limits", async () =>
  assert.deepEqual(await checkSourceSize(), []));
