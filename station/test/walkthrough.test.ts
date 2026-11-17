import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  checkWalkthroughV2,
  codeRefs,
  parseWalkthrough,
  sourceKey,
  type Walkthrough,
  walkRows,
  WalkthroughView,
} from "../src/walkthrough.js";

const ADDR = "org/repo/review-pr-7/review/walkthrough/w.json";
const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const OTHER = "c".repeat(40);
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const CTRL_DOWN = "\x1b[1;5B";
const CTRL_UP = "\x1b[1;5A";

const v1 = parseWalkthrough(ADDR, {
  version: 1,
  head: "abcdef1234567890",
  title: "Demo PR",
  summary: "Overall **summary**.",
  chunks: [
    {
      id: "one",
      title: "First chunk",
      summary: "Chunk intro.",
      sections: [
        { title: "Alpha", markdown: "Alpha prose with `code`.", file: { path: "a.ts", lines: [2, 3] } },
        { title: "Beta", markdown: "Beta prose." },
      ],
    },
    { id: "two", title: "Second chunk", sections: [{ title: "Gamma", markdown: "Gamma prose.", file: { path: "missing.ts" } }] },
  ],
});

function v2Doc(steps: unknown[]): Record<string, unknown> {
  return {
    version: 2,
    pr: 7,
    base: BASE,
    head: HEAD,
    title: "Rounding",
    summary: "Summary.",
    chunks: [{ id: "r", title: "The rounding rule", sections: [{ title: "Room list price", steps }] }],
  };
}

const lines = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `${tag}${i + 1}`).join("\n") + "\n";

const v2 = parseWalkthrough(
  ADDR,
  v2Doc([
    { markdown: "Before, rounding was here.", code: { path: "p.rb", lines: [2, 3], rev: "base" } },
    { code: { path: "q.rb", lines: [1, 2], rev: "base" } },
    { markdown: "Now it is per person.", code: { path: "p.rb", lines: [4, 5] } },
    { markdown: "Earlier attempt.", code: { path: "p.rb", lines: [1, 1], rev: OTHER } },
    { markdown: "Closing thought." },
  ]),
);

function view(w: Walkthrough, sources: Array<[string, string | null]>, opened: Array<[string, string, number]> = []): WalkthroughView {
  return new WalkthroughView({
    walkthrough: w,
    sources: new Map(sources),
    subtitle: "org/repo/review-pr-7",
    onQuit: () => {},
    onOpen: (rev, file, line) => opened.push([rev, file, line]),
  });
}

function text(v: WalkthroughView): string {
  return v.render(140).map((l) => stripTerminalSequences(l)).join("\n");
}

function v1View(opened: Array<[string, string, number]> = []): WalkthroughView {
  const head = "abcdef1234567890";
  return view(v1, [[`${head}:a.ts`, "one\ntwo\nthree\nfour\n"], [`${head}:missing.ts`, null]], opened);
}

function v2View(opened: Array<[string, string, number]> = []): WalkthroughView {
  const v = view(
    v2,
    [
      [`${BASE}:p.rb`, lines(6, "old")],
      [`${BASE}:q.rb`, lines(3, "q")],
      [`${HEAD}:p.rb`, lines(6, "new")],
      [`${OTHER}:p.rb`, lines(2, "mid")],
    ],
    opened,
  );
  v.handleInput(CTRL_DOWN);
  v.handleInput(CTRL_DOWN);
  return v;
}

test("rows list the overview, then each chunk followed by its sections", () => {
  assert.deepEqual(walkRows(v1).map((r) => r.kind), ["overview", "chunk", "section", "section", "chunk", "section"]);
});

test("a v1 section becomes one step pinned to the head", () => {
  const steps = v1.chunks[0]?.sections[0]?.steps;
  assert.equal(steps?.length, 1);
  assert.deepEqual(steps?.[0]?.code, { path: "a.ts", lines: [2, 3], rev: "abcdef1234567890", revKind: "head" });
  assert.equal(v1.chunks[1]?.sections[0]?.steps[0]?.code?.lines, null);
});

test("ctrl+up/down read straight through and the main pane follows", () => {
  const v = v1View();
  assert.match(text(v), /Overall summary\./);
  v.handleInput(CTRL_DOWN);
  assert.match(text(v), /Chunk intro\./);
  v.handleInput(CTRL_DOWN);
  const alpha = text(v);
  assert.match(alpha, /Alpha prose with code\./);
  assert.match(alpha, /a\.ts:2-3 head · abcdef1234/);
  assert.match(alpha, /2 ▎two/);
  v.handleInput(CTRL_UP);
  assert.equal(v.position, 1);
  for (let i = 0; i < 10; i++) v.handleInput(CTRL_DOWN);
  assert.equal(v.position, 5);
  assert.match(text(v), /missing\.ts not found at head abcdef1234/);
});

test("tab focuses the outline, enter jumps, esc returns", () => {
  const v = v1View();
  v.handleInput("\t");
  assert.equal(v.focusedSidebar, true);
  v.handleInput("j");
  v.handleInput("j");
  v.handleInput("j");
  assert.equal(v.position, 0);
  v.handleInput("\r");
  assert.equal(v.focusedSidebar, false);
  assert.equal(v.position, 3);
  assert.match(text(v), /Beta prose\./);
  v.handleInput("\t");
  assert.equal(v.handleEscape(), true);
  assert.equal(v.handleEscape(), false);
});

test("v2 parses steps with base, head and explicit commit revisions", () => {
  const steps = v2.chunks[0]?.sections[0]?.steps ?? [];
  assert.equal(steps.length, 5);
  assert.deepEqual(steps.map((s) => s.code?.revKind ?? null), ["base", "base", "head", "commit", null]);
  assert.equal(steps[0]?.code?.rev, BASE);
  assert.equal(steps[2]?.code?.rev, HEAD);
  assert.deepEqual(
    codeRefs(v2).map(sourceKey),
    [`${BASE}:p.rb`, `${BASE}:q.rb`, `${HEAD}:p.rb`, `${OTHER}:p.rb`],
  );
});

test("v2 reports every problem with its JSON path", () => {
  const { errors } = checkWalkthroughV2(ADDR, {
    ...v2Doc([
      {},
      { code: { path: "/abs.rb", lines: [5, 2] } },
      { markdown: "x", code: { path: "a.rb", lines: [1, 2], rev: "head" } },
      { markdown: "x", code: { path: "a.rb", lines: [1], extra: true } },
    ]),
    base: "main",
    note: "?",
  });
  assert.deepEqual(errors, [
    "$: unknown field note",
    "$.base: must be the full 40-character merge-base sha",
    "$.chunks[0].sections[0].steps[0]: needs markdown, code or both",
    "$.chunks[0].sections[0].steps[1].code.path: must be repository-relative",
    "$.chunks[0].sections[0].steps[1].code.lines: start 5 is after end 2",
    '$.chunks[0].sections[0].steps[2].code.rev: must be "base" or a full 40-character commit sha; omit it for the head',
    "$.chunks[0].sections[0].steps[3].code: unknown field extra",
    "$.chunks[0].sections[0].steps[3].code.lines: must be [start, end] with positive integers",
  ]);
  assert.throws(() => parseWalkthrough(ADDR, { ...v2Doc([{}]) }), /needs markdown, code or both/);
});

test("snippets render from their own revision with a revision label", () => {
  const out = text(v2View());
  assert.match(out, /p\.rb:2-3 base · bbbbbbbbbb/);
  assert.match(out, /2 ▎old2/);
  assert.match(out, /q\.rb:1-2 base · bbbbbbbbbb/);
  assert.match(out, /p\.rb:4-5 head · aaaaaaaaaa/);
  assert.match(out, /4 ▎new4/);
  assert.match(out, /p\.rb:1-1 commit · cccccccccc/);
  assert.match(out, /1 ▎mid1/);
  assert.match(out, /step 1\/5/);
});

test("up/down move the step focus and e opens the focused snippet at its revision", () => {
  const opened: Array<[string, string, number]> = [];
  const v = v2View(opened);
  v.handleInput("e");
  v.handleInput(DOWN);
  v.handleInput(DOWN);
  assert.equal(v.focusedStep, 2);
  v.handleInput("e");
  v.handleInput(DOWN);
  v.handleInput(DOWN);
  v.handleInput(DOWN);
  assert.equal(v.focusedStep, 4);
  v.handleInput("e");
  v.handleInput(UP);
  v.handleInput("e");
  assert.deepEqual(opened, [
    [BASE, "p.rb", 2],
    [HEAD, "p.rb", 4],
    [OTHER, "p.rb", 1],
  ]);
});

test("a range outside the file is an error in place", () => {
  const w = parseWalkthrough(ADDR, v2Doc([{ markdown: "x", code: { path: "p.rb", lines: [5, 9] } }]));
  const v = view(w, [[`${HEAD}:p.rb`, lines(6, "new")]]);
  v.handleInput(CTRL_DOWN);
  v.handleInput(CTRL_DOWN);
  assert.match(text(v), /lines 5-9 are outside p\.rb \(6 lines at head\)/);
});

test("scrolling the focused step off screen moves focus to the first visible step", () => {
  const steps = Array.from({ length: 12 }, (_, i) => ({ markdown: `Step ${i + 1} prose.`, code: { path: "p.rb", lines: [1, 6] } }));
  const w = parseWalkthrough(ADDR, v2Doc(steps));
  const rows = process.stdout.rows;
  Object.defineProperty(process.stdout, "rows", { value: 20, configurable: true });
  try {
    const v = view(w, [[`${HEAD}:p.rb`, lines(6, "new")]]);
    v.handleInput(CTRL_DOWN);
    v.handleInput(CTRL_DOWN);
    text(v);
    assert.equal(v.focusedStep, 0);
    for (let i = 0; i < 30; i++) v.handleInput("j");
    text(v);
    assert.ok(v.focusedStep > 0);
    const focused = v.focusedStep;
    v.handleInput(DOWN);
    const out = text(v);
    assert.equal(v.focusedStep, focused + 1);
    assert.match(out, new RegExp(`Step ${focused + 2} prose\\.`));
  } finally {
    Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
  }
});
