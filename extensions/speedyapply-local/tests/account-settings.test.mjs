import test from "node:test";
import assert from "node:assert/strict";
import {
  readAccountSettings,
  saveAccountSettings,
} from "../src/custom/account-settings.js";
import { popupPage, until } from "./helpers/popup-page.mjs";

function fixture(seed = {}) {
  let data = structuredClone(seed);
  return {
    get: async (key) => {
      assert.equal(key, "autofillAccount");
      return structuredClone(data);
    },
    set: async (next) => {
      data = structuredClone(next);
    },
    value: () => data.autofillAccount,
  };
}

test("account settings preserve a saved password during email edits and support explicit clearing", async () => {
  const storage = fixture({
    autofillAccount: {
      accountEmail: "old@example.test",
      accountPassword: "synthetic-old",
      extra: "retained",
    },
  });
  assert.deepEqual(await readAccountSettings(storage), {
    accountEmail: "old@example.test",
    useProfileEmail: false,
    hasPassword: true,
  });
  const draft = {
    accountEmail: " new@example.test ",
    useProfileEmail: true,
    password: "",
  };
  await saveAccountSettings(storage, draft);
  assert.deepEqual(storage.value(), {
    accountEmail: "new@example.test",
    useProfileEmail: true,
    accountPassword: "synthetic-old",
    extra: "retained",
  });
  await saveAccountSettings(storage, { ...draft, password: " synthetic-new " });
  assert.equal(storage.value().accountPassword, " synthetic-new ");
  assert.deepEqual(
    await saveAccountSettings(storage, { ...draft, clearPassword: true }),
    { hasPassword: false },
  );
  assert.equal(storage.value().accountPassword, "");
});

test("popup saves credentials locally, hides the existing password, and reports write failures", async () => {
  const storage = fixture();
  const sent = [];
  const h = popupPage(async (msg) => {
    sent.push(msg);
    return { error: "No job selected" };
  }, storage);
  const find = (id) => h.w.document.getElementById(id);
  function input(id, value) {
    const node = find(id);
    Object.getOwnPropertyDescriptor(
      h.w.HTMLInputElement.prototype,
      "value",
    ).set.call(node, value);
    node.dispatchEvent(new h.w.Event("input", { bubbles: true }));
  }
  try {
    await until(() => find("jobs-account-toggle"));
    find("jobs-account-toggle").click();
    await until(() => find("jobs-account-email"));
    input("jobs-account-email", "fixture@example.test");
    input("jobs-account-password", "synthetic-password");
    await until(
      () => find("jobs-account-password").value === "synthetic-password",
    );
    find("jobs-account-save").click();
    await until(() =>
      find("jobs-account-status").textContent.includes("已保存"),
    );
    assert.equal(storage.value().accountEmail, "fixture@example.test");
    assert.equal(storage.value().accountPassword, "synthetic-password");
    assert.equal(find("jobs-account-password").type, "password");
    assert.equal(find("jobs-account-password").value, "");
    find("jobs-account-toggle").click();
    await until(() => !find("jobs-account-form"));
    find("jobs-account-toggle").click();
    await until(() => find("jobs-account-password"));
    assert.equal(find("jobs-account-password").value, "");
    assert.match(h.w.document.body.textContent, /更换密码/);
    storage.set = async () => {
      throw Error("synthetic sensitive error");
    };
    find("jobs-account-save").click();
    await until(() =>
      find("jobs-account-status").textContent.includes("保存失败"),
    );
    assert(!h.w.document.body.textContent.includes("sensitive"));
    assert(!JSON.stringify(sent).includes("synthetic-password"));
    assert(!JSON.stringify(sent).includes("fixture@example.test"));
    assert.deepEqual(h.errors, []);
  } finally {
    h.close();
  }
});
