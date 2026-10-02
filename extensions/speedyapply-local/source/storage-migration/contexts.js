import { failure } from "./codec.js";
/** @param {typeof chrome} browser @param {chrome.runtime.MessageSender} sender */
export async function quiesce(browser, sender) {
  if (!browser.runtime.getContexts || !browser.storage.local.setAccessLevel)
    throw failure(
      "migration_writer_active",
      "当前浏览器无法核实旧窗口已停止，请更新 Chrome；原资料已保留",
    );
  if (
    sender.id !== browser.runtime.id ||
    !sender.documentId ||
    sender.frameId !== 0 ||
    !Number.isInteger(sender.tab?.id) ||
    sender.url !== browser.runtime.getURL("migration.html")
  )
    throw failure("migration_writer_active", "请从 jobs 的资料迁移页面操作");
  await browser.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  const contexts = await browser.runtime.getContexts({});
  const workers = contexts.filter(
    (context) =>
      context.contextType === "BACKGROUND" &&
      context.tabId === -1 &&
      !context.incognito,
  );
  const pages = contexts.filter(
    (context) =>
      context.contextType === "TAB" &&
      context.documentId === sender.documentId &&
      context.tabId === sender.tab.id &&
      context.documentUrl === sender.url &&
      context.frameId === 0 &&
      !context.incognito,
  );
  if (workers.length !== 1 || pages.length !== 1 || contexts.length !== 2)
    throw failure(
      "migration_writer_active",
      "请先保存并关闭其他 jobs 插件窗口，只保留当前迁移页面；申请网页无需刷新",
    );
}
