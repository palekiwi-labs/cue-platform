import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { sourceBlocks } from "../src/blocks.js";
import type { ComposeRequest } from "../src/changes.js";
import { type FindingsRun, FindingsView, parseFinding } from "../src/findings.js";
import { ReaderView } from "../src/reader.js";
import {
  docFor,
  findingDoc,
  locate,
  ReaderComments,
  readerRound,
  walkthroughDoc,
} from "../src/reader-comments.js";
import { emptyReaderComments, parseReaderComments, type ReaderCommentState } from "../src/state.js";
import type { Walkthrough } from "../src/walkthrough.js";

const ADDRESS = "org/repo/review-pr-1/review/runs/123-abc";

function run(message: string, fix: string | null = "Use `b` instead.\n\nThen retest."): FindingsRun {
  return {
    address: ADDRESS,
    runId: "123-abc",
    context: "org/repo/review-pr-1",
    subject: "PR #1",
    base: "b".repeat(40),
    head: "a".repeat(40),
    source: "verifiers-x.json",
    summary: {},
    analysis: {},
    findings: [
      parseFinding(
        {
          id: "F1",
          title: "Off by one",
          severity: "high",
          file: "src/a.ts",
          line_start: 3,
          message,
          suggested_fix: fix,
          verification: { verdict: "verified", reasoning: "Checked the loop." },
        },
        0,
      ),
    ],
  };
}

const MESSAGE = "First paragraph.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nLast paragraph.";

const WALK: Walkthrough = {
  address: "org/repo/review-pr-1/review/walkthrough/w.json",
  pr: 1,
  base: "b".repeat(40),
  head: "a".repeat(40),
  title: "W",
  summary: "",
  chunks: [
    {
      id: "auth",
      title: "Auth",
      summary: "",
      sections: [{ title: "Login", steps: [{ markdown: "Step one.\n\nStep two.", code: null }] }],
    },
  ],
};

function store(state: ReaderCommentState = emptyReaderComments()): { comments: ReaderComments; saved: ReaderCommentState[] } {
  const saved: ReaderCommentState[] = [];
  return { comments: new ReaderComments(state, (s) => saved.push(s)), saved };
}

test("blocks split on blank lines but keep fenced code whole", () => {
  assert.deepEqual(
    sourceBlocks(MESSAGE).map((b) => b.text),
    ["First paragraph.", "```ts\nconst a = 1;\n\nconst b = 2;\n```", "Last paragraph."],
  );
});

test("finding doc has message, fix and verification sections", () => {
  const r = run(MESSAGE);
  const doc = findingDoc(r, r.findings[0]!);
  assert.deepEqual(doc.sections.map((s) => s.heading), ["Message", "Suggested fix", "Verification"]);
  assert.deepEqual(doc.target, { kind: "finding", source: ADDRESS, item: "F1", item_title: "Off by one" });
});

test("locate follows a moved block and gives up on a missing or ambiguous one", () => {
  const r = run(MESSAGE);
  const doc = findingDoc(r, r.findings[0]!);
  assert.equal(locate(doc, { section: "Message", block: 2, quote: "Last paragraph." }), 2);
  const longer = run(`Intro.\n\n${MESSAGE}`);
  const movedDoc = findingDoc(longer, longer.findings[0]!);
  assert.equal(locate(movedDoc, { section: "Message", block: 2, quote: "Last paragraph." }), 3);
  assert.equal(locate(doc, { section: "Message", block: 0, quote: "Gone." }), null);
  assert.equal(locate(doc, { section: "Nope", block: 0, quote: "First paragraph." }), null);
  const twice = findingDoc(run("Same.\n\nSame."), run("Same.\n\nSame.").findings[0]!);
  assert.equal(locate(twice, { section: "Message", block: 5, quote: "Same." }), null);
});

test("walkthrough doc targets one step by chunk id, section and step", () => {
  const doc = walkthroughDoc(WALK, 0, 0, 0)!;
  assert.equal(doc.target.item, "auth/0/0");
  assert.equal(doc.target.item_title, "Auth / Login");
  assert.equal(walkthroughDoc(WALK, 0, 1, 0), null);
});

test("reader comments persist on every change and parse back", () => {
  const { comments, saved } = store();
  const r = run(MESSAGE);
  const target = findingDoc(r, r.findings[0]!).target;
  const c = comments.add(target, "Message", 0, "First paragraph.", "why?", 10);
  comments.update(c.id, "why not?");
  assert.equal(saved.length, 2);
  const back = parseReaderComments(JSON.stringify(saved[1]));
  assert.equal(back.comments[0]!.text, "why not?");
  assert.equal(comments.forTarget(target).length, 1);
  comments.remove([c.id]);
  assert.equal(comments.size, 0);
  assert.deepEqual(parseReaderComments('{"schema":"other"}'), emptyReaderComments());
});

test("round entries mark comments whose block or item is gone as outdated", () => {
  const { comments } = store();
  const r = run(MESSAGE);
  const doc = findingDoc(r, r.findings[0]!);
  comments.add(walkthroughDoc(WALK, 0, 0, 0)!.target, "Login", 1, "Step two.", "unclear", 1);
  comments.add(doc.target, "Message", 2, "Last paragraph.", "ok", 2);
  comments.add(doc.target, "Message", 0, "Removed text.", "stale", 3);
  comments.add({ ...doc.target, item: "F9" }, "Message", 0, "x", "lost", 4);
  const loaders = { run: () => r, walkthrough: () => WALK };
  const round = readerRound(comments.all(), loaders);
  assert.deepEqual(
    round.map((c) => [c.target, c.text, c.outdated]),
    [
      ["finding", "ok", false],
      ["finding", "stale", true],
      ["finding", "lost", true],
      ["walkthrough", "unclear", false],
    ],
  );
  assert.equal(docFor(comments.all()[0]!, { run: () => r, walkthrough: () => { throw new Error("gone"); } }), null);
});

function reader(comments: ReaderComments | null, reply: string | null = "needs a test") {
  const r = run(MESSAGE);
  const composed: ComposeRequest[] = [];
  const copied: string[] = [];
  let closed = 0;
  const v = new ReaderView({
    doc: findingDoc(r, r.findings[0]!),
    comments,
    onClose: () => closed++,
    onCompose: (req, done) => {
      composed.push(req);
      done(reply);
    },
    onCopy: (t) => copied.push(t),
  });
  return { v, composed, copied, closed: () => closed };
}

function screen(v: ReaderView, width = 100): string {
  return v.render(width).map(stripTerminalSequences).join("\n");
}

test("reader steps through blocks across sections and comments on the focused one", () => {
  const { comments } = store();
  const { v, composed, copied } = reader(comments);
  screen(v);
  v.handleInput("j");
  v.handleInput("y");
  assert.deepEqual(copied, ["```ts\nconst a = 1;\n\nconst b = 2;\n```"]);
  v.handleInput("j");
  v.handleInput("j");
  v.handleInput("c");
  assert.equal(composed[0]!.text, "");
  const [c] = comments.all();
  assert.equal(c!.section, "Suggested fix");
  assert.equal(c!.block, 0);
  assert.equal(c!.quote, "Use `b` instead.");
  const text = screen(v);
  assert.match(text, /┃ comment/);
  assert.match(text, /┃ needs a test/);
  assert.match(text, /1 comment/);
});

test("c on a commented block edits it, d deletes it", () => {
  const { comments } = store();
  const { v, composed } = reader(comments, "first");
  screen(v);
  v.handleInput("c");
  v.handleInput("c");
  assert.equal(composed[1]!.text, "first");
  assert.equal(comments.size, 1);
  v.handleInput("d");
  assert.equal(comments.size, 0);
});

test("n jumps between commented blocks and wraps", () => {
  const { comments } = store();
  const r = run(MESSAGE);
  const t = findingDoc(r, r.findings[0]!).target;
  comments.add(t, "Message", 2, "Last paragraph.", "a", 1);
  comments.add(t, "Verification", 0, "Checked the loop.", "b", 2);
  const { v } = reader(comments);
  screen(v);
  v.handleInput("n");
  assert.equal(v.focused, 2);
  v.handleInput("n");
  assert.equal(v.focused, 5);
  v.handleInput("n");
  assert.equal(v.focused, 2);
  assert.match(screen(v), /wrapped/);
});

test("outdated comments are listed at the end with their quote", () => {
  const { comments } = store();
  const r = run(MESSAGE);
  comments.add(findingDoc(r, r.findings[0]!).target, "Message", 0, "Old wording.", "stale note", 1);
  const { v } = reader(comments);
  const text = screen(v);
  assert.match(text, /Outdated comments/);
  assert.match(text, /> Old wording\./);
  assert.match(text, /stale note/);
});

test("reader without a store reads only, and q and esc close it", () => {
  const { v, composed, closed } = reader(null);
  screen(v);
  v.handleInput("c");
  assert.equal(composed.length, 0);
  assert.doesNotMatch(screen(v), /c comment/);
  v.handleInput("q");
  assert.equal(v.handleEscape(), true);
  assert.equal(closed(), 2);
});

test("reader renders within the width", () => {
  const { comments } = store();
  const { v } = reader(comments);
  for (const l of v.render(60)) assert.ok(visibleWidth(l) <= 60);
});

test("enter in the findings view opens the reader on the current finding", () => {
  const r = run(MESSAGE);
  const read: string[] = [];
  const v = new FindingsView({
    run: r,
    sources: new Map(),
    onQuit: () => {},
    onOpen: () => {},
    onRead: (f) => read.push(f.id),
    commentCount: () => 2,
  });
  v.handleInput("\r");
  assert.deepEqual(read, ["F1"]);
  assert.match(v.render(120).map(stripTerminalSequences).join("\n"), /2✎ HIGH/);
});
