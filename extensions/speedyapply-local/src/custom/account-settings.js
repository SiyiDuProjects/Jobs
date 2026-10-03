// Account credentials stay in this browser. Never send them to management,
// diagnostics, Profiles or runtime messages from the settings UI.
const pending = new WeakMap();
async function accountOperation(storage, operation) {
  // Serialize the whole read/modify/write, including reads after reopening.
  // Web Locks coordinate separate popup contexts; the local queue also supports
  // hosts without that API. It contains promises, never credential copies.
  const locks = globalThis.navigator?.locks;
  if (locks) return locks.request("jobs-account-settings", operation);
  const previous = pending.get(storage);
  let release;
  const current = new Promise((resolve) => (release = resolve));
  pending.set(storage, current);
  try {
    await previous;
    return await operation();
  } finally {
    release();
    if (pending.get(storage) === current) pending.delete(storage);
  }
}

export async function readAccountSettings(storage) {
  return accountOperation(storage, async () => {
    const { autofillAccount: account = {} } =
      await storage.get("autofillAccount");
    return {
      accountEmail: account.accountEmail || "",
      useProfileEmail: account.useProfileEmail === true,
      hasPassword: !!account.accountPassword,
    };
  });
}

export async function saveAccountSettings(storage, draft) {
  // Capture this save's intent before waiting for another operation.
  const { accountEmail, useProfileEmail, password, clearPassword } = draft;
  return accountOperation(storage, async () => {
    const { autofillAccount: previous = {} } =
      await storage.get("autofillAccount");
    const account = {
      ...previous,
      accountEmail: accountEmail.trim(),
      useProfileEmail: useProfileEmail === true,
      accountPassword: clearPassword
        ? ""
        : password || previous.accountPassword || "",
    };
    await storage.set({ autofillAccount: account });
    return { hasPassword: !!account.accountPassword };
  });
}
