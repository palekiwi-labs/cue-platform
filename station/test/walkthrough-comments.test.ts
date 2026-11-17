import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { ComposeRequest } from "../src/changes.js";
import {
  emptyWalkthroughComments,
  loadWalkthroughComments,
  parseWalkthroughComments,
  saveWalkthroughComments,
  stepFingerprint,
  type WalkthroughCommentState,
  type WalkthroughDraft,
} from "../src/state.js";
import { parseWalkthrough, type Walkthrough, WalkthroughView } from "../src/walkthrough.js";
import { WalkthroughDrafts } from "../src/walkthrough-comments.js";

const draft: WalkthroughDraft = {
  id: "d1",
  chunk: "r",
  section: 0,
  section_title: "Room list price",
  step: 2,
  fingerprint: stepFingerprint("Now it is per person."),
  text: "why per person?",
  created_at: 5,
};

test("step fingerprints follow the markdown", () => {
  assert.equal(stepFingerprint("a"), stepFingerprint("a"));
  assert.notEqual(stepFingerprint("a"), stepFingerprint("b"));
  assert.match(stepFingerprint(""), /^[0-9a-f]{16}$/);
});

test("parseWalkthroughComments tolerates garbage and drops invalid entries", () => {
  assert.deepEqual(parseWalkthroughComments(null), emptyWalkthroughComments());
  assert.deepEqual(parseWalkthroughComments("nope"), emptyWalkthroughComments());
  assert.deepEqual(parseWalkthroughComments(JSON.stringify({ schema: "station/comments@1", comments: [draft] })), emptyWalkthroughComments());
  const parsed = parseWalkthroughComments(
    JSON.stringify({
      schema: "station/walkthrough-comments@1",
      comments: [draft, { ...draft, step: -1 }, { ...draft, section: "0" }, { id: "x" }],
    }),
  );
  assert.deepEqual(parsed.comments, [draft]);
});

test("walkthrough drafts round-trip through the cache per review key", () => {
  const home = process.env.HOME;
  process.env.HOME = mkdtempSync(`${tmpdir()}/station-home-`);
  try {
    assert.deepEqual(loadWalkthroughComments("k"), emptyWalkthroughComments());
    saveWalkthroughComments("k", { schema: "station/walkthrough-comments@1", comments: [draft] });
    assert.deepEqual(loadWalkthroughComments("k").comments, [draft]);
    assert.deepEqual(loadWalkthroughComments("other"), emptyWalkthroughComments());
  } finally {
    process.env.HOME = home;
  }
});

const ADDR = "org/repo/review-pr-7/review/walkthrough/w.json";
const DOWN = "\x1b[B";
const CTRL_DOWN = "\x1b[1;5B";

function walk(markdown: string[]): Walkthrough {
  return parseWalkthrough(ADDR, {
    version: 2,
    pr: 7,
    base: "b".repeat(40),
    head: "a".repeat(40),
    title: "Rounding",
    chunks: [
      { id: "intro", title: "Intro", sections: [{ title: "Setup", steps: [{ markdown: "Setup prose." }] }] },
      { id: "r", title: "The rounding rule", sections: [{ title: "Room list price", steps: markdown.map((m) => ({ markdown: m })) }] },
    ],
  });
}

interface Harness {
  v: WalkthroughView;
  drafts: WalkthroughDrafts;
  saved: WalkthroughCommentState[];
  composed: ComposeRequest[];
  reply: { text: string | null };
}

function harness(w: Walkthrough, initial = emptyWalkthroughComments()): Harness {
  const saved: WalkthroughCommentState[] = [];
  const composed: ComposeRequest[] = [];
  const reply = { text: "why per person?" as string | null };
  const drafts = new WalkthroughDrafts(initial, (s) => saved.push(s), () => w, (req, done) => {
    composed.push(req);
    done(reply.text);
  });
  const v = new WalkthroughView({
    walkthrough: w,
    sources: new Map(),
    subtitle: "org/repo/review-pr-7",
    onQuit: () => {},
    onOpen: () => {},
    drafts,
  });
  return { v, drafts, saved, composed, reply };
}

function screen(v: WalkthroughView): string {
  return v.render(140).map((l) => stripTerminalSequences(l)).join("\n");
}

function press(v: WalkthroughView, ...keys: string[]): void {
  for (const k of keys) v.handleInput(k);
}

const STEPS = ["Before, rounding was here.", "Now it is per person.", "Closing thought."];

test("c comments on the focused step and shows it above the step", () => {
  const { v, saved, composed } = harness(walk(STEPS));
  press(v, "c");
  assert.equal(composed.length, 0);
  press(v, CTRL_DOWN, CTRL_DOWN, CTRL_DOWN, CTRL_DOWN);
  assert.match(screen(v), /c comment/);
  press(v, DOWN, "c");
  assert.equal(composed[0]?.title, "Room list price · step 2/3");
  const d = saved.at(-1)?.comments[0];
  assert.deepEqual(
    { chunk: d?.chunk, section: d?.section, title: d?.section_title, step: d?.step, text: d?.text },
    { chunk: "r", section: 0, title: "Room list price", step: 1, text: "why per person?" },
  );
  assert.equal(d?.fingerprint, stepFingerprint("Now it is per person."));
  const out = screen(v);
  assert.match(out, /┃ comment  step 2\/3.*\n.*┃ why per person\?.*\n.*Now it is per person\./);
  assert.ok(out.indexOf("Before, rounding") < out.indexOf("┃ comment"));
  assert.match(out, /E\/d edit\/delete/);
});

test("c on a commented step edits its draft, E edits and d deletes", () => {
  const { v, saved, composed, reply } = harness(walk(STEPS));
  press(v, CTRL_DOWN, CTRL_DOWN, CTRL_DOWN, CTRL_DOWN, "c");
  reply.text = "second thought";
  press(v, "c");
  assert.equal(composed[1]?.text, "why per person?");
  assert.equal(composed[1]?.title, "Room list price · step 1/3");
  assert.equal(saved.at(-1)?.comments.length, 1);
  assert.equal(saved.at(-1)?.comments[0]?.text, "second thought");
  reply.text = "third";
  press(v, "E");
  assert.equal(saved.at(-1)?.comments[0]?.text, "third");
  press(v, DOWN, "d", "E");
  assert.equal(saved.at(-1)?.comments.length, 1);
  assert.equal(composed.length, 3);
  press(v, "\x1b[A", "d");
  assert.equal(saved.at(-1)?.comments.length, 0);
  assert.doesNotMatch(screen(v), /┃/);
});

test("a regenerated step leaves its draft outdated and hidden", () => {
  const first = harness(walk(STEPS));
  press(first.v, CTRL_DOWN, CTRL_DOWN, CTRL_DOWN, CTRL_DOWN, DOWN, "c");
  const state = first.saved.at(-1) ?? emptyWalkthroughComments();
  const regenerated = walk(["Before, rounding was here.", "Now it is per guest.", "Closing thought."]);
  const { v, drafts } = harness(regenerated, state);
  press(v, CTRL_DOWN, CTRL_DOWN, CTRL_DOWN, CTRL_DOWN, DOWN);
  const d = drafts.all()[0]!;
  assert.equal(drafts.locate(d), null);
  assert.equal(drafts.title(d), "Room list price · outdated");
  assert.doesNotMatch(screen(v), /┃/);
  assert.match(screen(v), /c comment/);
  const same = harness(walk(STEPS), state);
  assert.deepEqual(same.drafts.locate(d), { chunk: 1, section: 0, step: 1 });
});
