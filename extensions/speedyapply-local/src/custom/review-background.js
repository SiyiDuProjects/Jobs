// Relay the review within one browser tab. Never submit or choose an answer here.
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
      return chrome.tabs.sendMessage(
        sender.tab.id,
        {
          type: "jobs:review-view",
          id: message.id,
          data: message.data,
          sourceDocumentId: sender.documentId,
        },
        { frameId: 0 },
      );
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
