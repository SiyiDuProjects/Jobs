// One projection for page execution and the popup. Never includes account data.
export function effectiveAutofillSettings(data) {
  return {
    enabled: data.autofillEnabled !== false,
    autofillSettings: {
      autoClickNextPage: false,
      autoSubmit: false,
      ...data.settings?.autofillSettings,
      saveApplications: true,
      saveResponses: true,
    },
  };
}
