import { test } from "node:test";
import assert from "node:assert/strict";
import { builtinActions } from "../src/actions.js";
import type { Exec } from "../src/exec.js";
import type { Pr } from "../src/picker/prs/model.js";

const PR = { repo: "acme/api", number: 7, headRef: "fix-it" } as Pr;

function recorder(code = 0): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code, stdout: "", stderr: code === 0 ? "" : "denied" };
  };
  return { exec, calls };
}

test("lgtm approves with a confirm step", async () => {
  const { exec, calls } = recorder();
  const lgtm = builtinActions(exec, "/").find((a) => a.label === "lgtm");
  assert.ok(lgtm);
  assert.equal(lgtm.confirm, true);
  const o = await lgtm.run(PR);
  assert.equal(o.ok, true);
  assert.deepEqual(calls, [
    [
      "gh", "pr", "review", "7", "-R", "acme/api",
      "--approve", "--body", "lgtm",
    ],
  ]);
});

test("self-review request adds palekiwi as reviewer", async () => {
  const { exec, calls } = recorder();
  const [, request] = builtinActions(exec, "/");
  assert.ok(request);
  assert.notEqual(request.confirm, true);
  await request.run(PR);
  assert.deepEqual(calls, [
    ["gh", "pr", "edit", "7", "-R", "acme/api", "--add-reviewer", "palekiwi"],
  ]);
});

test("a failing gh call reports its stderr", async () => {
  const { exec } = recorder(1);
  const [lgtm] = builtinActions(exec, "/");
  const o = await lgtm!.run(PR);
  assert.equal(o.ok, false);
  assert.match(o.text, /denied/);
});
