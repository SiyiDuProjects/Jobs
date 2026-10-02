import { JobsProfileContract } from "../../../src/custom/profile-contract.js";
import { JobsDiagnostics } from "../../../src/custom/diagnostics.js";

// Adapters request one current server snapshot for a filling run. Validate at
// the boundary so a malformed response cannot become an application's facts.
export async function jobsGetProfile() {
  const result = await chrome.runtime.sendMessage({
    type: "jobs:tab-profile",
    refresh: true,
  });
  if (result?.error) throw Error(result.error);
  const value = result?.data;
  if (!value?.profile) throw Error("请选择本页 Profile");
  const profile = JobsProfileContract.assertProfile(value.profile);
  JobsDiagnostics?.profile?.({ ...value, profileName: profile.profileName });
  return profile;
}
