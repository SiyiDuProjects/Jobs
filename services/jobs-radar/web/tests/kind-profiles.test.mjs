import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const compiled = await build({
  entryPoints: [
    new URL("../src/manage/kind-profiles.ts", import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { defaultKindProfiles, profileForKind } = await import(
  "data:text/javascript;base64," +
    Buffer.from(compiled.outputFiles[0].text).toString("base64")
);
const profiles = [
  { id: "ng", profileName: "Newgrad" },
  { id: "intern", profileName: "Intern" },
];
test("name defaults keep identities after rename, and explicit settings win", () => {
  const saved = defaultKindProfiles(profiles);
  assert.deepEqual(saved, { newgrad: "ng", intern: "intern" });
  const renamed = profiles.map((p) => ({
    ...p,
    profileName: "Renamed " + p.profileName,
  }));
  assert.equal(profileForKind("internship", renamed, saved), "intern");
  assert.equal(
    profileForKind("newgrad", profiles, { newgrad: "intern" }),
    "intern",
  );
});
test("missing and ambiguous bindings never select the other Profile", () => {
  assert.equal(profileForKind("internship", [profiles[0]]), undefined);
  assert.equal(
    profileForKind("internship", [
      ...profiles,
      { id: "duplicate", profileName: "实习" },
    ]),
    undefined,
  );
  assert.equal(
    profileForKind("internship", profiles, { intern: "deleted" }),
    undefined,
  );
});
