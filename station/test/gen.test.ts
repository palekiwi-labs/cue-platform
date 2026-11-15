import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDiff } from "../src/gen.js";
import { emptyState, loadPacket, loadState } from "../src/packet.js";

const sample = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@ function foo()",
  " context",
  "-old",
  "+new",
  "+added",
  "diff --git a/old.ts b/new.ts",
  "similarity index 90%",
  "rename from old.ts",
  "rename to new.ts",
  "--- a/old.ts",
  "+++ b/new.ts",
  "@@ -2,1 +2,1 @@",
  " ctx",
  "-x",
  "+y",
].join("\n");

test("parseDiff extracts files, hunks, renames", () => {
  const files = parseDiff(sample);
  assert.equal(files.length, 2);
  assert.equal(files[0]?.path, "src/a.ts");
  assert.equal(files[0]?.status, "modified");
  assert.equal(files[0]?.hunks.length, 1);
  assert.equal(files[0]?.additions, 2);
  assert.equal(files[0]?.deletions, 1);
  const h = files[0]?.hunks[0];
  assert.equal(h?.oldStart, 1);
  assert.equal(h?.oldLines, 3);
  assert.equal(h?.newStart, 1);
  assert.equal(h?.newLines, 4);
  assert.equal(h?.section, "function foo()");
  assert.equal(files[1]?.status, "renamed");
  assert.equal(files[1]?.oldPath, "old.ts");
  assert.equal(files[1]?.path, "new.ts");
});

test("parseDiff handles added files without old counts", () => {
  const files = parseDiff(
    [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
    ].join("\n"),
  );
  const h = files[0]?.hunks[0];
  assert.equal(files[0]?.status, "added");
  assert.equal(h?.oldStart, 0);
  assert.equal(h?.oldLines, 0);
  assert.equal(h?.newLines, 2);
});

test("loadPacket rejects non-packets and emptyState round-trips", () => {
  assert.throws(() => loadPacket("{}"));
  assert.throws(() => loadPacket('{"kind":"other","schema_version":1}'));
  const s = emptyState("p1");
  const again = loadState(JSON.stringify(s), "p1");
  assert.deepEqual(again.read, {});
  assert.throws(() => loadState("not json", "p1").read, undefined);
});
