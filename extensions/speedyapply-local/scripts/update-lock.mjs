import fs from "node:fs/promises";

const busy = () =>
  Error(
    "Another update is running. Wait for its result; do not remove its lock",
  );
function isDead(value) {
  let pid;
  try {
    pid = JSON.parse(value).pid;
  } catch {
    throw Error("Invalid update lock; inspect its owner before recovery");
  }
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw Error("Invalid update lock; inspect its owner before recovery");
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
}

// Serialize recovery separately: two contenders must never unlink each other's
// new lock. Unknown/malformed locks and live PIDs are deliberately preserved.
export async function acquireUpdateLock(lockPath, io = fs) {
  let lock;
  try {
    lock = await io.open(lockPath, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const guardPath = lockPath + ".recovery";
    const guard = await io.open(guardPath, "wx").catch((failure) => {
      if (failure.code === "EEXIST") throw busy();
      throw failure;
    });
    try {
      if ((await io.lstat(lockPath)).isSymbolicLink())
        throw Error("Unsafe update lock path");
      const original = await io.readFile(lockPath, "utf8");
      if (!isDead(original)) throw busy();
      if ((await io.readFile(lockPath, "utf8")) !== original) throw busy();
      await io.unlink(lockPath);
      lock = await io.open(lockPath, "wx").catch((failure) => {
        if (failure.code === "EEXIST") throw busy();
        throw failure;
      });
    } finally {
      await guard.close();
      await io.unlink(guardPath);
    }
  }
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
  } catch (error) {
    await lock.close();
    await io.unlink(lockPath);
    throw error;
  }
  return lock;
}
