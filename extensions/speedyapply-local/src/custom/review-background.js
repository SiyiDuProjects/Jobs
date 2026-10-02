// Relay the review within one browser tab. Never submit or choose an answer here.
async function presentReview(tabId, message) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, message, {
      frameId: 0,
    });
    if (result?.ok || result?.error) return result;
  } catch (error) {
    if (!/Receiving end does not exist/i.test(error.message)) throw error;
  }
  if (!message.data) return { ok: true };
  // Embedded ATS forms may run on a host with no content script. Install only
  // the review surface: loading the application runtime could start a new run.
  const frames = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: ["custom/review-surface.js"],
  });
  const documentId = frames.find((frame) => frame.frameId === 0)?.documentId;
  if (!documentId) throw Error("Review document unavailable");
  return chrome.tabs.sendMessage(tabId, message, { documentId });
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!["jobs:review-present", "jobs:review-action"].includes(message?.type))
    return;
  const run = async () => {
    if (
      sender.id !== chrome.runtime.id ||
      !sender.tab?.id ||
      typeof message.id !== "string"
    )
      throw Error("Application tab required");
    if (message.type === "jobs:review-present") {
      if (!sender.documentId) throw Error("Application document required");
      if (
        message.data &&
        (message.data.id !== message.id ||
          !Array.isArray(message.data.items) ||
          message.data.items.length > 90 ||
          JSON.stringify(message.data).length > 250000)
      )
        throw Error("Invalid review");
      return presentReview(sender.tab.id, {
        type: "jobs:review-view",
        id: message.id,
        data: message.data,
        sourceDocumentId: sender.documentId,
      });
    }
    if (
      sender.frameId !== 0 ||
      !["confirm", "locate", "answer"].includes(message.action) ||
      typeof message.documentId !== "string"
    )
      throw Error("Top-level review required");
    if (
      message.action === "answer" &&
      (!message.payload ||
        !Number.isInteger(message.payload.version) ||
        JSON.stringify(message.payload).length > 50000)
    )
      throw Error("Invalid answer");
    return chrome.tabs.sendMessage(
      sender.tab.id,
      {
        type: "jobs:review-command",
        id: message.id,
        action: message.action,
        itemId: message.itemId,
        payload: message.payload,
      },
      { documentId: message.documentId },
    );
  };
  run().then(reply, (error) =>
    reply({ error: error.message || "申请页面已变化，请检查。" }),
  );
  return true;
});
