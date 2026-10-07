// Local behavior preferences are independent of synced Profiles and answers.
export const workdaySkillsPreferenceKey = "jobsWorkdaySkillsAutofill";

export async function readAutofillPreferences(
  storage = globalThis.chrome?.storage?.local,
) {
  const values = await storage?.get(workdaySkillsPreferenceKey);
  return { workdaySkills: values?.[workdaySkillsPreferenceKey] === true };
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
