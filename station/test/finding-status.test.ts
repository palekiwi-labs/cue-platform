import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chooseFindingStatus, saveFindingStatus } from "../src/finding-status.js";
import { FindingsView, loadRun } from "../src/findings.js";

const address = "org/repo/review-pr-1/review/runs/run";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "finding-status-"));
  const dir = join(root, address);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), JSON.stringify({ head: "abc", context: "org/repo/review-pr-1" }));
  const file = join(dir, "verifiers-a.json");
  writeFileSync(file, JSON.stringify({ extra: "preserved", findings: [{ id: "F3", status: "open", severity: "high", message: "text" }] }));
  return { root, file, run: loadRun(address, root) };
}

test("writes before publishing, preserves fields and clears dismissal on reopen", () => {
  const f = fixture();
  try {
    let calls = 0;
    const result = saveFindingStatus(f.run, "F3", "dismissed", (subject, event) => {
      calls++;
      assert.equal(JSON.parse(readFileSync(f.file, "utf8")).findings[0].status, "dismissed");
      assert.equal(event.context, "org/repo/review-pr-1");
      assert.equal(event.address, `${address}/verifiers-a.json`);
      assert.match(subject, /^cue\.evt\.v1\.[^.]+\.artifact_update$/);
      assert.equal(event.actor, "operator");
      assert.equal(event.summary, "F3 open -> dismissed");
      return false;
    }, f.root);
    assert.equal(calls, 1);
    assert.equal(result.published, false);
    assert.equal(result.run.findings[0]!.status, "dismissed");
    saveFindingStatus(result.run, "F3", "open", () => { throw new Error("offline"); }, f.root);
    const data = JSON.parse(readFileSync(f.file, "utf8"));
    assert.equal(data.extra, "preserved");
    assert.equal(data.findings[0].dismiss_reason, null);
    assert.equal(data.findings[0].status, "open");
    saveFindingStatus(f.run, "F3", "open", () => { assert.fail("no-op published"); }, f.root);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("failed write does not publish", () => {
  const f = fixture();
  try {
    rmSync(f.file);
    mkdirSync(f.file);
    assert.throws(() => saveFindingStatus(f.run, "F3", "applied", () => { assert.fail("published"); }, f.root));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("navigation does not change status; popup requires selection and confirmation", () => {
  const f = fixture();
  try {
    let actions: Record<string, () => void> = {};
    let title = "";
    const view = new FindingsView({ run: f.run, sources: new Map(), onQuit() {}, onOpen() {},
      onStatus: finding => chooseFindingStatus(f.run, finding, (content, _dismissable, keys) => {
        title = content.title;
        actions = keys ?? {};
      }, () => { assert.fail("published before confirmation"); }),
    });
    for (const key of ["j", "k", "g", "G"]) view.handleInput(key);
    assert.equal(title, "");
    view.handleInput("s");
    assert.match(title, /finding status/);
    actions.b!();
    assert.equal(title, "confirm status");
    assert.deepEqual(Object.keys(actions), ["\r"]);
    assert.equal(JSON.parse(readFileSync(f.file, "utf8")).findings[0].status, "open");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
