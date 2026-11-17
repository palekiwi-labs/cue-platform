import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkoutPr, trackedChanges } from "../src/checkout.js";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "station-checkout-"));
  const git = (...args: string[]): void => void execFileSync("git", ["-C", dir, ...args]);
  git("init", "-q");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", "a.txt");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  return dir;
}

test("untracked files do not count as changes", async () => {
  const dir = repo();
  writeFileSync(join(dir, "new.txt"), "x\n");
  assert.deepEqual(await trackedChanges(dir), []);
});

test("checkout refuses a root with tracked changes", async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.txt"), "b\n");
  await assert.rejects(checkoutPr(dir, 1), /uncommitted changes \(1 file\)/);
});
