// Website settings own behavior preferences; retain the old local value until synced.
export const workdaySkillsPreferenceKey = "jobsWorkdaySkillsAutofill";

export async function readAutofillPreferences(
  storage = globalThis.chrome?.storage?.local,
) {
  const values = /** @type {any} */ (
    await storage?.get(["settings", workdaySkillsPreferenceKey])
  );
  return {
    workdaySkills:
      (values?.settings?.autofillSettings?.workdaySkills ??
        values?.[workdaySkillsPreferenceKey]) === true,
  };
}

export async function saveWorkdaySkillsPreference(enabled, storage) {
  await storage.set({ [workdaySkillsPreferenceKey]: enabled === true });
}

export function allowsAutomaticFill(node, preferences, rules = []) {
  return !rules?.some(
    ({ setting, selector }) =>
      preferences[setting] !== true && node.closest(selector),
  );
}
