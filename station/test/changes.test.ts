import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ChangesView, type ComposeRequest } from "../src/changes.js";
import { Drafts } from "../src/drafts.js";
import { buildPacketFromDiff } from "../src/gen.js";
import { type DiffRoundComment, reviewContext, type RoundComment, slugify } from "../src/round.js";
import {
  type CommentState,
  emptyComments,
  emptyFolds,
  type FoldState,
  parseComments,
  parseFolds,
} from "../src/state.js";

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

interface Harness {
  v: ChangesView;
  saved: FoldState[];
  opened: [string, number][];
  comments: CommentState[];
  composed: ComposeRequest[];
  reply: { text: string | null };
  submitted: RoundComment[][];
  submitOk: { ok: boolean };
  copied: string[];
  hub: Drafts;
}

function view(initial: CommentState = emptyComments()): Harness {
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
  const comments: CommentState[] = [];
  const composed: ComposeRequest[] = [];
  const reply = { text: "looks odd" as string | null };
  const submitted: RoundComment[][] = [];
  const submitOk = { ok: true };
  const copied: string[] = [];
  const hub = new Drafts((rc, done) => {
    submitted.push(rc);
    done(submitOk.ok);
  });
  const v = new ChangesView({
    title: "t",
    subtitle: "sub",
    packet,
    folds: emptyFolds(),
    comments: initial,
    headMatches: true,
    onQuit: () => {},
    onFolds: (f) => saved.push(f),
    onComments: (c) => comments.push(c),
    onCompose: (req, done) => {
      composed.push(req);
      done(reply.text);
    },
    onOpen: (f, line) => opened.push([f.path, line]),
    drafts: hub,
    onCopy: (text) => copied.push(text),
  });
  return { v, saved, opened, comments, composed, reply, submitted, submitOk, copied, hub };
}

function screen(v: ChangesView): string {
  return v.render(100).map(stripTerminalSequences).join("\n");
}

function keys(v: ChangesView, ...input: string[]): void {
  for (const k of input) v.handleInput(k);
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

test("the diff starts at the left edge with the file list on the right", () => {
  const { v } = view();
  for (const [width, sideWidth] of [[100, 28], [80, 26], [180, 48], [100, 28]] as const) {
    const body = v.render(width).map(stripTerminalSequences).slice(2, -1);
    const divider = width - sideWidth - 1;
    for (const l of body) {
      assert.equal(l[divider], "│", l);
      assert.equal(visibleWidth(l), width);
    }
    assert.ok(body.some((l) => l.slice(0, divider).includes("function foo()")));
    assert.ok(body.some((l) => l.slice(divider + 1).includes("b.txt")));
    assert.ok(body.every((l) => !l.slice(0, divider).includes("│")));
  }
  assert.ok(v.render(79).map(stripTerminalSequences).slice(2, -1).every((l) => !l.includes("│")));
  v.handleInput("t");
  assert.ok(v.render(100).map(stripTerminalSequences).slice(2, -1).every((l) => !l.includes("│")));
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

test("y copies the chunk, line or range location", () => {
  const { v, copied } = view();
  keys(v, "y");
  assert.match(screen(v), /copied src\/a\.ts:1-3/);
  keys(v, "j", "k");
  assert.doesNotMatch(screen(v), /copied/);
  copied.length = 0;
  keys(v, "y", "\r", "y", "j", "y", "V", "j", "y", "j", "y");
  assert.deepEqual(copied, ["src/a.ts:1-3", "src/a.ts:1", "src/a.ts:2 (base)", "src/a.ts:2", "src/a.ts:2-3"]);
});

test("open jumps to first changed line of the chunk", () => {
  const { v, opened } = view();
  v.handleInput("o");
  assert.deepEqual(opened, []);
  v.handleInput("e");
  v.handleInput("j");
  v.handleInput("e");
  v.handleInput("\x1b[1;5B");
  v.handleInput("e");
  assert.deepEqual(opened, [
    ["src/a.ts", 2],
    ["src/a.ts", 22],
    ["b.txt", 1],
  ]);
});

test("comment on a single line in line mode", () => {
  const { v, comments, composed } = view();
  keys(v, "\r", "j", "j", "c");
  assert.equal(composed[0]?.title, "src/a.ts · line 2");
  const c = comments.at(-1)?.comments[0];
  assert.equal(c?.path, "src/a.ts");
  assert.equal(c?.from, 2);
  assert.equal(c?.to, 2);
  assert.equal(c?.text, "looks odd");
  const text = screen(v);
  assert.match(text, /┃ comment  line 2/);
  assert.match(text, /┃ looks odd/);
});

test("range comment stays within one chunk", () => {
  const { v, comments, composed } = view();
  keys(v, "\r", "V", "j", "j", "j", "j", "j", "c");
  assert.equal(composed[0]?.title, "src/a.ts · lines 1 to 3");
  const c = comments.at(-1)?.comments[0];
  assert.deepEqual([c?.from, c?.to], [0, 3]);
});

test("line cursor crosses into the next chunk without a range", () => {
  const { v, opened } = view();
  keys(v, "\r", "j", "j", "j", "j", "o");
  assert.deepEqual(opened, []);
  keys(v, "e");
  assert.deepEqual(opened, [["src/a.ts", 21]]);
});

test("chunk comment from chunk mode", () => {
  const { v, comments } = view();
  keys(v, "c");
  const c = comments.at(-1)?.comments[0];
  assert.equal(c?.from, null);
  assert.match(screen(v), /comment  whole chunk/);
});

test("cancelled compose adds nothing", () => {
  const { v, comments, reply } = view();
  reply.text = null;
  keys(v, "\r", "c");
  assert.equal(comments.length, 0);
});

test("escape clears the range, then leaves line mode", () => {
  const { v } = view();
  assert.equal(v.handleEscape(), false);
  keys(v, "\r", "V");
  assert.match(screen(v), /end range/);
  assert.equal(v.handleEscape(), true);
  assert.match(screen(v), /E\/d edit\/delete  e open/);
  assert.equal(v.handleEscape(), true);
  assert.match(screen(v), /enter lines/);
  assert.equal(v.handleEscape(), false);
});

test("edit and delete a comment under the cursor", () => {
  const { v, comments, reply, opened, composed } = view();
  keys(v, "\r", "c");
  assert.equal(comments.at(-1)?.comments.length, 1);
  reply.text = "changed";
  keys(v, "e");
  assert.equal(composed.length, 1);
  assert.equal(opened.length, 1);
  keys(v, "E");
  assert.equal(comments.at(-1)?.comments[0]?.text, "changed");
  keys(v, "d");
  assert.equal(comments.at(-1)?.comments.length, 0);
  assert.doesNotMatch(screen(v), /changed/);
});

test("folded chunk shows its comment count", () => {
  const { v } = view();
  keys(v, "c", " ");
  assert.match(screen(v), /lines folded\)  1 comment/);
  assert.match(screen(v), /1 draft comment/);
});

test("comments on chunks no longer in the diff count as outdated", () => {
  const { v } = view({
    schema: "station/comments@1",
    comments: [{ id: "x", path: "src/a.ts", chunk: "gone", from: 0, to: 0, text: "old", created_at: 0 }],
  });
  assert.match(screen(v), /1 draft comment \(1 on outdated code\)/);
});

test("parseComments tolerates garbage and drops invalid entries", () => {
  assert.deepEqual(parseComments("nope"), emptyComments());
  assert.deepEqual(parseComments(null), emptyComments());
  const parsed = parseComments(
    JSON.stringify({ schema: "station/comments@1", comments: [{ id: 1 }, { id: "a", path: "p", chunk: "c", from: null, to: null, text: "t", created_at: 1 }] }),
  );
  assert.equal(parsed.comments.length, 1);
});

test("parseFolds tolerates garbage", () => {
  assert.deepEqual(parseFolds("nope"), emptyFolds());
  assert.deepEqual(parseFolds(null), emptyFolds());
});

test("comments navigator lists drafts in diff order with outdated last", () => {
  const { v, comments } = view();
  keys(v, "j", "c", "k", "\r", "j", "j", "c");
  const { v: w } = view({
    schema: "station/comments@1",
    comments: [
      { id: "x", path: "src/gone.ts", chunk: "gone", from: 0, to: 0, text: "stale note", created_at: 0 },
      ...(comments.at(-1)?.comments ?? []),
    ],
  });
  keys(w, "C");
  const text = screen(w);
  assert.match(text, /Comments 3/);
  const side = text.split("\n").filter((l) => l.includes("│")).map((l) => l.split("│").at(-1)).join("\n");
  const order = ["line 2", "whole chunk", "outdated"].map((s) => side.indexOf(s));
  assert.ok(order.every((i) => i !== -1), text);
  assert.ok(order[0]! < order[1]! && order[1]! < order[2]!, text);
  assert.match(text, /stale note/);
  assert.match(text, /E\/d edit\/delete/);
});

test("enter in the navigator jumps to the comment in line mode, unfolding", () => {
  const { v } = view();
  keys(v, "j", "c", " ", "g", "C", "\r");
  assert.doesNotMatch(screen(v), /lines folded/);
  assert.match(screen(v), /▶.*comment  whole chunk/);
  assert.match(screen(v), /E\/d edit\/delete/);
});

test("outdated drafts can be edited and deleted from the navigator", () => {
  const { v, comments, composed, reply } = view({
    schema: "station/comments@1",
    comments: [{ id: "x", path: "src/a.ts", chunk: "gone", from: 0, to: 0, text: "old", created_at: 0 }],
  });
  keys(v, "C", "\r");
  assert.match(screen(v), /Comments 1/);
  reply.text = "newer";
  keys(v, "e");
  assert.equal(composed.length, 0);
  keys(v, "E");
  assert.equal(composed[0]?.title, "src/a.ts · outdated");
  assert.equal(comments.at(-1)?.comments[0]?.text, "newer");
  keys(v, "d");
  assert.equal(comments.at(-1)?.comments.length, 0);
  assert.match(screen(v), /no draft comments/);
});

test("C toggles the sidebar back to files and esc returns to the diff", () => {
  const { v } = view();
  keys(v, "C");
  assert.match(screen(v), /Comments 0/);
  keys(v, "C");
  assert.match(screen(v), /Files 2/);
  assert.equal(v.handleEscape(), true);
  assert.match(screen(v), /enter lines/);
});

test("S in the navigator submits every listed draft and clears them", () => {
  const { v, submitted, comments } = view({
    schema: "station/comments@1",
    comments: [{ id: "x", path: "src/a.ts", chunk: "gone", from: null, to: null, text: "old", created_at: 0 }],
  });
  keys(v, "\r", "j", "V", "j", "c", "C", "S");
  const round = (submitted[0] ?? []) as DiffRoundComment[];
  assert.deepEqual(round.map((c) => c.target), ["diff", "diff"]);
  assert.equal(round.length, 2);
  const lines = round[0];
  assert.equal(lines?.anchor, "lines");
  assert.equal(lines?.outdated, false);
  assert.deepEqual(lines?.sides, ["old", "new"]);
  assert.deepEqual(lines?.old_lines, [2, 2]);
  assert.deepEqual(lines?.new_lines, [2, 2]);
  assert.equal(lines?.snippet, "-old\n+new");
  assert.equal(lines?.text, "looks odd");
  assert.deepEqual(
    { outdated: round[1]?.outdated, anchor: round[1]?.anchor, snippet: round[1]?.snippet },
    { outdated: true, anchor: "chunk", snippet: null },
  );
  assert.equal(comments.at(-1)?.comments.length, 0);
});

test("failed submit keeps the drafts", () => {
  const { v, submitted, comments, submitOk } = view();
  submitOk.ok = false;
  keys(v, "c", "C", "S");
  assert.equal(submitted.length, 1);
  assert.equal(comments.at(-1)?.comments.length, 1);
});

test("whole-chunk comment carries both line spans and the full body", () => {
  const { v, submitted } = view();
  keys(v, "c", "C", "S");
  const c = submitted[0]?.[0] as DiffRoundComment | undefined;
  assert.deepEqual([c?.old_lines, c?.new_lines], [[1, 2], [1, 3]]);
  assert.equal(c?.snippet, " context\n-old\n+new\n+added");
});

test("review context follows cue-review naming", () => {
  assert.equal(slugify("Feat/Some Thing"), "feat-some-thing");
  assert.equal(reviewContext("feat/x", null, null), "review-feat-x");
  assert.equal(reviewContext(null, null, "mine"), "mine");
  assert.throws(() => reviewContext(null, null, null), /--context/);
});

test("PR review rounds go to review-pr-N and reject --context", () => {
  assert.equal(reviewContext("feat/x", 42, null), "review-pr-42");
  assert.throws(() => reviewContext("feat/x", 42, "mine"), /--context/);
});

test("the navigator lists walkthrough drafts under their own group", () => {
  const { v, hub } = view();
  const walk = [{ tab: "walkthrough" as const, id: "w", title: "Room list price", where: "step 2/3", text: "why?", outdated: false }];
  const edited: string[] = [];
  hub.register("walkthrough", {
    entries: () => walk,
    edit: (id) => edited.push(id),
    remove: (ids) => walk.splice(0, walk.length, ...walk.filter((e) => !ids.includes(e.id))),
    round: () => [],
  });
  keys(v, "c");
  assert.match(screen(v), /1 draft comment, 1 on the walkthrough/);
  keys(v, "C");
  const text = screen(v);
  assert.match(text, /Comments 2/);
  assert.ok(text.indexOf("Changes 1") < text.indexOf("Walkthrough 1"), text);
  assert.match(text, /Room list price step 2\/3/);
  keys(v, "j", "\r");
  assert.match(screen(v), /open the walkthrough tab to jump to this comment/);
  keys(v, "E");
  assert.deepEqual(edited, ["w"]);
  keys(v, "d");
  assert.match(screen(v), /Comments 1/);
  assert.doesNotMatch(screen(v), /Walkthrough 1/);
});
