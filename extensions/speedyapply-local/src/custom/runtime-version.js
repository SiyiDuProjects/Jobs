import { JobsBuildInfo } from "./build-info.js";

// Disk updates do not replace a running worker. Keep that distinction visible
// without reloading a browser that may contain unfinished applications.
export async function runtimeVersion(client) {
  let installed;
  try {
    const response = await fetch(chrome.runtime.getURL("manifest.json"), {
      cache: "no-store",
    });
    if (response.ok) installed = (await response.json()).version_name;
  } catch {
    /* The running build is still useful when disk inspection fails. */
  }
  return {
    running: JobsBuildInfo.id,
    installed: installed || null,
    reloadRequired:
      (client && client !== JobsBuildInfo.id) ||
      (installed && installed !== JobsBuildInfo.id) ||
      false,
  };
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (
    message?.type !== "jobs:runtime-version" ||
    sender.id !== chrome.runtime.id
  )
    return;
  runtimeVersion(message.build).then(reply, () =>
    reply({ error: "无法核对插件版本" }),
  );
  return true;
});
