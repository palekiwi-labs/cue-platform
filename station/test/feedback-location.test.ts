import assert from "node:assert/strict";
import { test } from "node:test";
import { hunkAnchor, localGit, parseHunk, requiredCommits, resolveThread } from "../src/feedback-location.js";
import type { Located } from "../src/feedback-location.js";
import { gitFixture, LEFT_HUNK, RENAME_HUNK, RIGHT_HUNK, snapshot, thread } from "./feedback-fixture.js";

const reason = (l: Located): string => (l.ok ? "" : l.reason);

test("parseHunk numbers both sides and the anchor is the last line on the commented side", () => {
  const lines = parseHunk(RIGHT_HUNK + "\n");
  assert.deepEqual(lines?.map((l) => [l.kind, l.old, l.new]), [
    [" ", 2, 2], [" ", 3, 3], [" ", 4, 4], ["-", 5, null], ["+", null, 5],
  ]);
  assert.equal(hunkAnchor(RIGHT_HUNK, "RIGHT")?.text, "changed5");
  assert.equal(hunkAnchor(RIGHT_HUNK, "LEFT"), null);
  assert.deepEqual(hunkAnchor(LEFT_HUNK, "LEFT"), { kind: "-", text: "l8", old: 8, new: null });
  assert.equal(parseHunk("no header"), null);
  assert.equal(parseHunk("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b")?.length, 2);
});

test("current right-side threads open at the PR head on the reported line", () => {
  const f = gitFixture();
  try {
    const t = thread({ line: 7, original_line: 5 }, { original_commit: f.first, diff_hunk: RIGHT_HUNK });
    const s = snapshot(f, [t]);
    assert.deepEqual(requiredCommits(t, s), [f.head]);
    const loc = resolveThread(t, s, localGit(f.repo));
    assert.deepEqual(loc, { ok: true, rev: f.head, path: "a.ts", line: 7, side: "RIGHT", base: f.base, note: `PR head ${f.head.slice(0, 10)}` });
  } finally {
    f.cleanup();
  }
});

test("outdated threads open at their original commit, and mismatching lines are refused", () => {
  const f = gitFixture();
  try {
    const git = localGit(f.repo);
    const outdated = thread({ is_outdated: true, original_line: 5 }, { original_commit: f.first, diff_hunk: RIGHT_HUNK });
    const loc = resolveThread(outdated, snapshot(f, [outdated]), git);
    assert.equal(loc.ok, true);
    assert.equal(loc.ok && `${loc.rev}:${loc.path}:${loc.line}`, `${f.first}:a.ts:5`);
    const wrong = thread({ is_outdated: true, original_line: 6 }, { original_commit: f.first, diff_hunk: RIGHT_HUNK });
    const refused = resolveThread(wrong, snapshot(f, [wrong]), git);
    assert.equal(refused.ok, false);
    assert.match(reason(refused), /hunk ends at line 5, GitHub reports line 6/);
    const drifted = thread({ line: 6 }, { original_commit: f.first, diff_hunk: RIGHT_HUNK });
    const moved = resolveThread(drifted, snapshot(f, [drifted]), git);
    assert.match(reason(moved), /does not match the commented line/);
  } finally {
    f.cleanup();
  }
});

test("old-side threads open at the merge-base, following renames, and need a base-side hunk", () => {
  const f = gitFixture();
  try {
    const git = localGit(f.repo);
    const deleted = thread({ diff_side: "LEFT", line: 8, original_line: 8 }, { original_commit: f.first, diff_hunk: LEFT_HUNK });
    const s = snapshot(f, [deleted]);
    assert.deepEqual(requiredCommits(deleted, s), [f.head, f.baseTip]);
    const loc = resolveThread(deleted, s, git);
    assert.equal(loc.ok && `${loc.rev}:${loc.path}:${loc.line}:${loc.side}:${loc.base}`, `${f.base}:a.ts:8:LEFT:null`);
    const outdatedLeft = thread({ diff_side: "LEFT", is_outdated: true, original_line: 8 }, { original_commit: f.first, diff_hunk: LEFT_HUNK });
    assert.equal(resolveThread(outdatedLeft, s, git).ok, true);
    const renamed = thread({ path: "new.ts", diff_side: "LEFT", line: 3, original_line: 3 }, { original_commit: f.first, diff_hunk: RENAME_HUNK });
    const r = resolveThread(renamed, s, git);
    assert.equal(r.ok && `${r.path}:${r.line}`, "old.ts:3");
    const plus = thread({ diff_side: "LEFT", line: 5, original_line: 5 }, { original_commit: f.first, diff_hunk: RIGHT_HUNK });
    const p = resolveThread(plus, s, git);
    assert.match(reason(p), /does not end on a base-side line/);
  } finally {
    f.cleanup();
  }
});

test("missing commits, sides and lines are reported instead of guessed; file comments open at line 1", () => {
  const f = gitFixture();
  try {
    const git = localGit(f.repo);
    const s = snapshot(f);
    const gone = thread({ is_outdated: true, original_line: 5 }, { original_commit: "f".repeat(40), diff_hunk: RIGHT_HUNK });
    assert.match(reason(resolveThread(gone, s, git)), /not in the local repository/);
    const noSide = thread({ diff_side: null, line: 7 });
    assert.equal(resolveThread(noSide, s, git).ok, false);
    const noLine = thread({ is_outdated: true }, { original_commit: f.first });
    assert.match(reason(resolveThread(noLine, s, git)), /no line/);
    const tooFar = thread({ line: 99 }, { diff_hunk: RIGHT_HUNK });
    assert.match(reason(resolveThread(tooFar, s, git)), /has 11 lines/);
    const file = thread({ subject_type: "FILE", diff_side: null });
    const loc = resolveThread(file, s, git);
    assert.equal(loc.ok && `${loc.rev}:${loc.line}`, `${f.head}:1`);
  } finally {
    f.cleanup();
  }
});
