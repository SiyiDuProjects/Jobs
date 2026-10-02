// Only the small metadata fence is part of ordinary startup. Legacy readers and
// cleanup code are loaded by the explicit private migration page.
export const MIGRATION_JOURNAL = "jobsStorageMigrationV1";
let blocked = false;
let queue = Promise.resolve();
let loaded;
async function ready() {
  if (!loaded)
    loaded = chrome.storage.local.get(MIGRATION_JOURNAL).then((data) => {
      const state = data[MIGRATION_JOURNAL];
      blocked ||=
        !!state &&
        (typeof state !== "object" ||
          !("phase" in state) ||
          state.phase !== "complete");
    });
  await loaded;
}
async function assertOpen() {
  await ready();
  if (blocked)
    throw Object.assign(Error("正在迁移旧资料，资料和设置写入已暂停"), {
      code: "migration_in_progress",
    });
}
/** @template T @param {()=>Promise<T>} action @returns {Promise<T>} */
function serial(action) {
  const task = queue.then(action);
  queue = task.then(
    () => {},
    () => {},
  );
  return task;
}
export const JobsMigrationMaintenance = Object.freeze({
  assertOpen,
  /** @template T @param {()=>Promise<T>} action */
  write(action) {
    return serial(async () => {
      await assertOpen();
      return action();
    });
  },
  async freeze() {
    await ready();
    blocked = true;
    await queue;
  },
  async finish() {
    await queue;
    const data = await chrome.storage.local.get(MIGRATION_JOURNAL);
    const state = data[MIGRATION_JOURNAL];
    if (
      !state ||
      typeof state !== "object" ||
      !("phase" in state) ||
      state.phase !== "complete"
    )
      throw Error("迁移尚未核验完成");
    blocked = false;
  },
});
