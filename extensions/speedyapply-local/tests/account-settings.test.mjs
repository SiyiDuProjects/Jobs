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

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}
const turn = () => new Promise((done) => setTimeout(done, 0));

test("a pending clear followed by a blank-password save cannot restore the old password", async () => {
  const storage = fixture({
    autofillAccount: { accountPassword: "synthetic-old" },
  });
  const first = deferred(),
    second = deferred();
  const write = storage.set;
  let writes = 0;
  storage.set = async (value) => {
    await (++writes === 1 ? first.promise : second.promise);
    await write(value);
  };
  const clear = saveAccountSettings(storage, {
    accountEmail: "first@example.test",
    password: "",
    clearPassword: true,
  });
  await until(() => writes === 1);
  const preserve = saveAccountSettings(storage, {
    accountEmail: "second@example.test",
    password: "",
  });
  await turn();
  first.resolve();
  await clear;
  second.resolve();
  await preserve;
  assert.equal(storage.value().accountPassword, "");
  assert.equal(storage.value().accountEmail, "second@example.test");
});

test("reopened settings wait for an in-flight write before reading saved state", async () => {
  const storage = fixture({
    autofillAccount: {
      accountEmail: "old@example.test",
      accountPassword: "synthetic-old",
    },
  });
  const gate = deferred();
  const write = storage.set;
  let writing = false;
  storage.set = async (value) => {
    writing = true;
    await gate.promise;
    await write(value);
  };
  const pending = saveAccountSettings(storage, {
    accountEmail: "new@example.test",
    clearPassword: true,
  });
  await until(() => writing);
  const reopened = readAccountSettings(storage);
  await turn();
  gate.resolve();
  await pending;
  assert.deepEqual(await reopened, {
    accountEmail: "new@example.test",
    useProfileEmail: false,
    hasPassword: false,
  });
});

test("collapsing and reopening account settings preserves the unsaved draft", async () => {
  const h = popupPage(async () => ({ error: "No job selected" }), fixture());
  const find = (id) => h.w.document.getElementById(id);
  try {
    await until(() => find("jobs-account-toggle"));
    find("jobs-account-toggle").click();
    await until(() => find("jobs-account-email"));
    const email = find("jobs-account-email");
    Object.getOwnPropertyDescriptor(
      h.w.HTMLInputElement.prototype,
      "value",
    ).set.call(email, "draft@example.test");
    email.dispatchEvent(new h.w.Event("input", { bubbles: true }));
    await turn();
    find("jobs-account-toggle").click();
    await until(() => !find("jobs-account-form"));
    find("jobs-account-toggle").click();
    await until(() => find("jobs-account-email"));
    assert.equal(find("jobs-account-email").value, "draft@example.test");
  } finally {
    h.close();
  }
});

test("separate settings contexts serialize read-modify-write with the origin lock", async (t) => {
  if (!globalThis.navigator?.locks)
    return t.skip("Web Locks unavailable in this test host");
  const one = await import("../src/custom/account-settings.js?context=one");
  const two = await import("../src/custom/account-settings.js?context=two");
  const storage = fixture({
    autofillAccount: { accountPassword: "synthetic-old" },
  });
  const gate = deferred();
  const write = storage.set;
  let writes = 0;
  storage.set = async (value) => {
    if (++writes === 1) await gate.promise;
    await write(value);
  };
  const clearing = one.saveAccountSettings(
    { ...storage },
    { accountEmail: "first@example.test", clearPassword: true },
  );
  await until(() => writes === 1);
  const preserving = two.saveAccountSettings(
    { ...storage },
    { accountEmail: "second@example.test", password: "" },
  );
  await turn();
  gate.resolve();
  await Promise.all([clearing, preserving]);
  assert.equal(storage.value().accountPassword, "");
  assert.equal(storage.value().accountEmail, "second@example.test");
});

test("failed storage writes release the queue and a retry still clears the password", async () => {
  const storage = fixture({
    autofillAccount: { accountPassword: "synthetic-old" },
  });
  const write = storage.set;
  let writes = 0;
  storage.set = async (value) => {
    if (++writes === 1) throw Error("synthetic write failure");
    await write(value);
  };
  const draft = { accountEmail: "fixture@example.test", clearPassword: true };
  await assert.rejects(saveAccountSettings(storage, draft));
  await saveAccountSettings(storage, draft);
  assert.equal((await readAccountSettings(storage)).hasPassword, false);
});

function accountPopup(storage) {
  const h = popupPage(async () => ({ error: "No job selected" }), storage);
  const find = (id) => h.w.document.getElementById("jobs-account-" + id);
  return {
    ...h,
    find,
    async open() {
      await until(() => find("toggle"));
      find("toggle").click();
      await until(() => find("email"));
    },
    input(id, value) {
      Object.getOwnPropertyDescriptor(
        h.w.HTMLInputElement.prototype,
        "value",
      ).set.call(find(id), value);
      find(id).dispatchEvent(new h.w.Event("input", { bubbles: true }));
    },
    submit() {
      find("form").dispatchEvent(
        new h.w.Event("submit", { bubbles: true, cancelable: true }),
      );
    },
  };
}

test("repeated submit and collapse/reopen keep one pending save and its draft", async () => {
  const storage = fixture();
  const gate = deferred();
  const write = storage.set;
  let writes = 0;
  storage.set = async (value) => {
    writes++;
    await gate.promise;
    await write(value);
  };
  const h = accountPopup(storage);
  try {
    await h.open();
    h.input("email", "pending@example.test");
    h.input("password", "synthetic-pending");
    await turn();
    h.submit();
    h.submit();
    await until(() => writes === 1);
    h.find("toggle").click();
    await until(() => !h.find("form"));
    await h.open();
    assert.equal(h.find("email").value, "pending@example.test");
    assert.equal(h.find("save").disabled, true);
    gate.resolve();
    await until(() => h.find("status").textContent.includes("已保存"));
    assert.equal(writes, 1);
    assert.equal(h.find("password").value, "");
    assert.equal(storage.value().accountPassword, "synthetic-pending");
    assert.deepEqual(h.errors, []);
  } finally {
    gate.resolve();
    h.close();
  }
});

test("an older save acknowledgement cannot erase a newer draft or call it saved", async () => {
  const storage = fixture();
  const gate = deferred();
  const write = storage.set;
  let writing = false;
  storage.set = async (value) => {
    writing = true;
    await gate.promise;
    await write(value);
  };
  const h = accountPopup(storage);
  try {
    await h.open();
    h.input("email", "saved@example.test");
    h.input("password", "synthetic-saved");
    await turn();
    h.submit();
    await until(() => writing);
    // A late input callback may arrive even after the disabled render.
    h.input("email", "draft@example.test");
    h.input("password", "synthetic-new-draft");
    await turn();
    gate.resolve();
    await until(() => !h.find("save").disabled);
    assert.equal(h.find("email").value, "draft@example.test");
    assert.equal(h.find("password").value, "synthetic-new-draft");
    assert.match(h.find("status").textContent, /当前修改尚未保存/);
    assert.equal(storage.value().accountEmail, "saved@example.test");
    h.submit();
    await until(() => h.find("password").value === "");
    assert.equal(storage.value().accountPassword, "synthetic-new-draft");
    assert.deepEqual(h.errors, []);
  } finally {
    gate.resolve();
    h.close();
  }
});

test("a failed initial read retries on reopen without exposing its error", async () => {
  const storage = fixture({
    autofillAccount: { accountEmail: "fixture@example.test" },
  });
  const read = storage.get;
  let reads = 0;
  storage.get = async (key) => {
    if (++reads === 1) throw Error("synthetic sensitive failure");
    return read(key);
  };
  const h = accountPopup(storage);
  try {
    await until(() => h.find("toggle"));
    h.find("toggle").click();
    await until(() => h.find("status")?.textContent.includes("无法读取"));
    assert(!h.w.document.body.textContent.includes("sensitive"));
    h.find("toggle").click();
    await until(() => !h.find("form"));
    await h.open();
    assert.equal(h.find("email").value, "fixture@example.test");
    assert.deepEqual(h.errors, []);
  } finally {
    h.close();
  }
});
