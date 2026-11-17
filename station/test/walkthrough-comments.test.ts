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
import { Drafts, type PaneEntry } from "../src/drafts.js";
import { buildRound, type RoundComment } from "../src/round.js";

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
  diff: PaneEntry[];
  edited: string[];
  submitted: RoundComment[][];
  hub: Drafts;
}

function harness(w: Walkthrough, initial = emptyWalkthroughComments()): Harness {
  const saved: WalkthroughCommentState[] = [];
  const composed: ComposeRequest[] = [];
  const reply = { text: "why per person?" as string | null };
  const drafts = new WalkthroughDrafts(initial, (s) => saved.push(s), () => w, (req, done) => {
    composed.push(req);
    done(reply.text);
  });
  const diff: PaneEntry[] = [];
  const edited: string[] = [];
  const submitted: RoundComment[][] = [];
  const hub = new Drafts((rc, done) => {
    submitted.push(rc);
    done(true);
  });
  hub.register("changes", {
    entries: () => diff,
    edit: (id) => edited.push(id),
    remove: (ids) => diff.splice(0, diff.length, ...diff.filter((e) => !ids.includes(e.id))),
    round: () => [],
  });
  hub.register("walkthrough", drafts);
  const v = new WalkthroughView({
    walkthrough: w,
    sources: new Map(),
    subtitle: "org/repo/review-pr-7",
    onQuit: () => {},
    onOpen: () => {},
    drafts,
    comments: hub,
  });
  return { v, drafts, saved, composed, reply, diff, edited, submitted, hub };
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

function side(v: WalkthroughView): string {
  return v.render(140).map((l) => stripTerminalSequences(l).split("│").at(-1) ?? "").join("\n");
}

test("C lists diff and walkthrough drafts grouped per tab", () => {
  const { v, diff, edited } = harness(walk(STEPS));
  diff.push({ tab: "changes", id: "x", title: "src/a.ts", where: "line 2", text: "diff note", outdated: false });
  press(v, CTRL_DOWN, CTRL_DOWN, CTRL_DOWN, CTRL_DOWN, DOWN, DOWN, "c", "\x1b[A", "c");
  press(v, "C");
  const pane = side(v);
  assert.match(pane, /Comments 3/);
  assert.match(pane, /Changes 1.*\n.*src\/a\.ts line 2.*\n.*diff note.*\n.*Walkthrough 2.*\n.*Room list price step 2\/3.*\n.*why per person\?.*\n.*Room list price step 3\/3/);
  assert.match(screen(v), /enter jump/);
  press(v, "g", "\r");
  assert.match(screen(v), /open the changes tab to jump to this comment/);
  assert.equal(v.focusedSidebar, true);
  press(v, "E");
  assert.deepEqual(edited, ["x"]);
  press(v, "d");
  assert.equal(diff.length, 0);
  assert.match(side(v), /Comments 2/);
});

test("enter on a walkthrough draft jumps to its step; outdated drafts stay put", () => {
  const first = harness(walk(STEPS));
  press(first.v, CTRL_DOWN, CTRL_DOWN, CTRL_DOWN, CTRL_DOWN, DOWN, DOWN, "c");
  const state = first.saved.at(-1)!;
  const { v } = harness(walk(STEPS), state);
  press(v, "C", "\r");
  assert.equal(v.focusedSidebar, false);
  assert.equal(v.position, 4);
  assert.equal(v.focusedStep, 2);
  const gone = harness(walk(["a", "b", "c"]), state);
  press(gone.v, "C");
  assert.match(side(gone.v), /Room list price outdated/);
  press(gone.v, "\r");
  assert.equal(gone.v.focusedSidebar, true);
  assert.equal(gone.v.position, 0);
  press(gone.v, "d");
  assert.equal(gone.saved.at(-1)?.comments.length, 0);
  assert.match(side(gone.v), /no draft comments/);
});

test("C toggles the pane back to the outline and esc returns to the steps", () => {
  const { v } = harness(walk(STEPS));
  press(v, "C");
  assert.match(side(v), /Comments 0/);
  press(v, "C");
  assert.match(side(v), /Walkthrough 2 chunks/);
  assert.equal(v.handleEscape(), true);
  assert.equal(v.focusedSidebar, false);
});

test("S submits diff and walkthrough drafts in one round@2", () => {
  const w = parseWalkthrough(ADDR, {
    version: 2,
    base: "b".repeat(40),
    head: "a".repeat(40),
    title: "Rounding",
    chunks: [
      {
        id: "r",
        title: "The rounding rule",
        sections: [
          {
            title: "Room list price",
            steps: [{ markdown: "\n**Now** it is per person.\nMore.", code: { path: "p.rb", lines: [4, 5] } }, { markdown: "Closing." }],
          },
        ],
      },
    ],
  });
  const stale: WalkthroughDraft = { ...draft, id: "old", chunk: "gone", created_at: 1 };
  const { v, hub, submitted, saved } = harness(w, { schema: "station/walkthrough-comments@1", comments: [stale] });
  const removed: string[][] = [];
  hub.register("changes", {
    entries: () => [],
    edit: () => {},
    remove: (ids) => removed.push(ids),
    round: () => [{ id: "x", comment: { target: "diff", path: "a.ts", chunk: "f", outdated: false, anchor: "chunk", sides: [], old_lines: null, new_lines: null, snippet: null, text: "d", created_at: 0 } }],
  });
  press(v, CTRL_DOWN, CTRL_DOWN, "c", "C", "S");
  const round = submitted[0] ?? [];
  assert.deepEqual(round.map((c) => c.target), ["diff", "walkthrough", "walkthrough"]);
  assert.deepEqual(round[1], {
    target: "walkthrough",
    chunk: "r",
    section: "Room list price",
    step: 0,
    first_line: "**Now** it is per person.",
    path: "p.rb",
    lines: [4, 5],
    outdated: false,
    text: "why per person?",
    created_at: round[1]?.created_at,
  });
  assert.deepEqual(round[2], {
    target: "walkthrough",
    chunk: "gone",
    section: "Room list price",
    step: 2,
    first_line: null,
    path: null,
    lines: null,
    outdated: true,
    text: "why per person?",
    created_at: 1,
  });
  assert.deepEqual(removed, [["x"]]);
  assert.equal(saved.at(-1)?.comments.length, 0);
  const target = { repo: "org/repo", key: "k", title: "t", branch: "b", pr: 7 };
  assert.equal(buildRound(target, "b", "h", round, 9).schema, "station/round@2");
});
