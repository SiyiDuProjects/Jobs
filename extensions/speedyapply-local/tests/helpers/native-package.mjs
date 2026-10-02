import { buildPackage } from "../../scripts/build.mjs";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { discardCandidate } from "../../scripts/package-state.mjs";
let pending;
export const nativePackage = () => (pending ||= buildPackage());
after(async () => {
  if (!pending) return;
  const candidate = await pending.catch(() => null);
  if (candidate)
    await discardCandidate(
      fileURLToPath(new URL("../../", import.meta.url)),
      candidate.stage,
    );
});
