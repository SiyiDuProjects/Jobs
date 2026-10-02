import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { nativePackage } from "./helpers/native-package.mjs";
test("shared branding reaches the native popup, manifest and worker without rewriting vendor code", async () => {
  const brand = JSON.parse(
    await fs.readFile(
      new URL(
        "../../../services/jobs-radar/config/brand.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const source = JSON.parse(
    await fs.readFile(new URL("../src/manifest.json", import.meta.url), "utf8"),
  );
  const result = await nativePackage(),
    manifest = JSON.parse(
      await fs.readFile(result.stage + "/manifest.json", "utf8"),
    );
  assert.equal(manifest.name, brand.name);
  assert.equal(manifest.key, source.key);
  assert(
    manifest.content_scripts.some((row) =>
      row.matches.includes(new URL(brand.website).origin + "/*"),
    ),
  );
  const worker = await fs.readFile(result.stage + "/background.js", "utf8");
  assert(worker.includes(brand.website));
  assert(worker.includes(result.buildId));
  const popup = await fs.readFile(result.stage + "/popup.html", "utf8");
  assert(!popup.includes("chunks/"));
  assert(!popup.includes("SpeedyApply"));
  assert(popup.includes("custom/popup.js"));
  const popupBundle = await fs.readFile(
    result.stage + "/custom/popup.js",
    "utf8",
  );
  assert(popupBundle.includes("jobs-profile-switch"));
  assert(popupBundle.includes("segment__item"));
});
