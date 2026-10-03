import { JobsPrivateSession } from "./private-session.js";
import { JobsManagementSync } from "./management-sync.js";

let stopping;
// A normal gateway failure is retryable. Only the authenticated recovery
// runtime's explicit code stops active pages and releases their private facts.
/** @param {Response} response @param {number} [expectedEpoch] */
export async function checkRecoveryPause(response, expectedEpoch = undefined) {
  const check = () => {
    if (expectedEpoch !== undefined)
      JobsPrivateSession.assertCurrent(expectedEpoch);
  };
  check();
  if (response.status !== 503) return;
  let result;
  try {
    result = await response.clone().json();
  } catch {
    check();
    return;
  }
  // Body parsing can finish after the request's connection was replaced.
  // Check before its pause code can clear the replacement's private facts.
  check();
  if (result?.code !== "recovery_application_pause") return;
  if (!stopping)
    stopping = JobsPrivateSession.clear(
      undefined,
      JobsManagementSync.pendingSnapshot,
    ).finally(() => {
      stopping = undefined;
    });
  await stopping;
  throw Object.assign(
    Error("服务恢复期间投递已暂停，已填内容与待同步记录已保留"),
    { code: "recovery_application_pause" },
  );
}
