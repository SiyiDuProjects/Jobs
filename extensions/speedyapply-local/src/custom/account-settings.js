// Account credentials stay in this browser. Never send them to management,
// diagnostics, Profiles or runtime messages from the settings UI.
export async function readAccountSettings(storage) {
  const { autofillAccount: account = {} } =
    await storage.get("autofillAccount");
  return {
    accountEmail: account.accountEmail || "",
    useProfileEmail: account.useProfileEmail === true,
    hasPassword: !!account.accountPassword,
  };
}

export async function saveAccountSettings(storage, draft) {
  const { autofillAccount: previous = {} } =
    await storage.get("autofillAccount");
  const account = {
    ...previous,
    accountEmail: draft.accountEmail.trim(),
    useProfileEmail: draft.useProfileEmail === true,
    accountPassword: draft.clearPassword
      ? ""
      : draft.password || previous.accountPassword || "",
  };
  await storage.set({ autofillAccount: account });
  return { hasPassword: !!account.accountPassword };
}
