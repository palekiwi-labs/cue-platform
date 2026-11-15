import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ChangesView } from "../src/changes.js";
import { buildPacketFromDiff } from "../src/gen.js";
import { emptyFolds, type FoldState, parseFolds } from "../src/state.js";

const diff = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@ function foo()",
  " context",
  "-old",
  "+new",
  "+added",
  "@@ -20,2 +21,2 @@ function bar()",
  " ctx",
  "-x",
  "+y",
  "diff --git a/b.txt b/b.txt",
  "index 1111111..2222222 100644",
  "--- a/b.txt",
  "+++ b/b.txt",
  "@@ -1 +1 @@",
  "-b",
  "+c",
].join("\n");

function view(): { v: ChangesView; saved: FoldState[]; opened: [string, number][] } {
  const packet = buildPacketFromDiff(diff, {
    repoPath: "/tmp/r",
    branch: "b",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    subject: "s",
    now: 0,
  });
  const saved: FoldState[] = [];
  const opened: [string, number][] = [];
  const v = new ChangesView({
    title: "t",
    subtitle: "sub",
    packet,
    folds: emptyFolds(),
    headMatches: true,
    onQuit: () => {},
    onFolds: (f) => saved.push(f),
    onOpen: (f, line) => opened.push([f.path, line]),
  });
  return { v, saved, opened };
}

test("render fills the terminal at exact width", () => {
  const { v } = view();
  const lines = v.render(100);
  assert.equal(lines.length, Math.max(8, process.stdout.rows ?? 40));
  for (const l of lines) assert.ok(visibleWidth(l) <= 100);
  const text = lines.map(stripTerminalSequences).join("\n");
  assert.match(text, /src\/a\.ts/);
  assert.match(text, /function bar\(\)/);
});

test("fold chunk persists and hides its lines", () => {
  const { v, saved } = view();
  v.handleInput(" ");
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.chunks.length, 1);
  const text = v.render(100).map(stripTerminalSequences).join("\n");
  assert.match(text, /lines folded/);
  assert.doesNotMatch(text, /\+ added/);
});

test("open jumps to first changed line of the chunk", () => {
  const { v, opened } = view();
  v.handleInput("o");
  v.handleInput("j");
  v.handleInput("o");
  v.handleInput("n");
  v.handleInput("o");
  assert.deepEqual(opened, [
    ["src/a.ts", 2],
    ["src/a.ts", 22],
    ["b.txt", 1],
  ]);
});

test("parseFolds tolerates garbage", () => {
  assert.deepEqual(parseFolds("nope"), emptyFolds());
  assert.deepEqual(parseFolds(null), emptyFolds());
});
