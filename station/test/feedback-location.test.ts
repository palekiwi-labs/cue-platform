import assert from "node:assert/strict";
import { test } from "node:test";
import { commentHunk, hunkAnchor, localGit, parseHunk, requiredCommits, resolveThread } from "../src/feedback-location.js";
import type { Located } from "../src/feedback-location.js";
import { comment, gitFixture, LEFT_HUNK, RENAME_HUNK, RIGHT_HUNK, snapshot, thread } from "./feedback-fixture.js";

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
    const t = thread({ line: 7, originalLine: 5 }, { originalCommit: f.first, diffHunk: RIGHT_HUNK });
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
    const outdated = thread({ isOutdated: true, originalLine: 5 }, { originalCommit: f.first, diffHunk: RIGHT_HUNK });
    const loc = resolveThread(outdated, snapshot(f, [outdated]), git);
    assert.equal(loc.ok, true);
    assert.equal(loc.ok && `${loc.rev}:${loc.path}:${loc.line}`, `${f.first}:a.ts:5`);
    const wrong = thread({ isOutdated: true, originalLine: 6 }, { originalCommit: f.first, diffHunk: RIGHT_HUNK });
    const refused = resolveThread(wrong, snapshot(f, [wrong]), git);
    assert.equal(refused.ok, false);
    assert.match(reason(refused), /hunk ends at line 5, GitHub reports line 6/);
    const drifted = thread({ line: 6 }, { originalCommit: f.first, diffHunk: RIGHT_HUNK });
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
    const deleted = thread({ diffSide: "LEFT", line: 8, originalLine: 8 }, { originalCommit: f.first, diffHunk: LEFT_HUNK });
    const s = snapshot(f, [deleted]);
    assert.deepEqual(requiredCommits(deleted, s), [f.head, f.baseTip]);
    const loc = resolveThread(deleted, s, git);
    assert.equal(loc.ok && `${loc.rev}:${loc.path}:${loc.line}:${loc.side}:${loc.base}`, `${f.base}:a.ts:8:LEFT:null`);
    const outdatedLeft = thread({ diffSide: "LEFT", isOutdated: true, originalLine: 8 }, { originalCommit: f.first, diffHunk: LEFT_HUNK });
    assert.equal(resolveThread(outdatedLeft, s, git).ok, true);
    const renamed = thread({ path: "new.ts", diffSide: "LEFT", line: 3, originalLine: 3 }, { originalCommit: f.first, diffHunk: RENAME_HUNK });
    const r = resolveThread(renamed, s, git);
    assert.equal(r.ok && `${r.path}:${r.line}`, "old.ts:3");
    const plus = thread({ diffSide: "LEFT", line: 5, originalLine: 5 }, { originalCommit: f.first, diffHunk: RIGHT_HUNK });
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
    const gone = thread({ isOutdated: true, originalLine: 5 }, { originalCommit: "f".repeat(40), diffHunk: RIGHT_HUNK });
    assert.match(reason(resolveThread(gone, s, git)), /not in the local repository/);
    const noSide = thread({ diffSide: null, line: 7 });
    assert.equal(resolveThread(noSide, s, git).ok, false);
    const noLine = thread({ isOutdated: true }, { originalCommit: f.first });
    assert.match(reason(resolveThread(noLine, s, git)), /no line/);
    const tooFar = thread({ line: 99 }, { diffHunk: RIGHT_HUNK });
    assert.match(reason(resolveThread(tooFar, s, git)), /has 11 lines/);
    const file = thread({ subjectType: "FILE", diffSide: null });
    const loc = resolveThread(file, s, git);
    assert.equal(loc.ok && `${loc.rev}:${loc.line}`, `${f.head}:1`);
  } finally {
    f.cleanup();
  }
});

test("a comment's own diff hunk overrides the thread's, which is used otherwise", () => {
  const t = thread({ diffHunk: RIGHT_HUNK, comments: [comment(), comment({ id: "c2", diffHunk: LEFT_HUNK }), comment({ id: "c3", diffHunk: null })] });
  assert.equal(commentHunk(t, t.comments[0]), RIGHT_HUNK);
  assert.equal(commentHunk(t, t.comments[1]), LEFT_HUNK);
  assert.equal(commentHunk(t, t.comments[2]), null);
  assert.equal(commentHunk(t, undefined), RIGHT_HUNK);
});
