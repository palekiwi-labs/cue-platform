import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { parseWalkthrough, walkRows, WalkthroughView } from "../src/walkthrough.js";

const walkthrough = parseWalkthrough("org/repo/review-pr-7/review/walkthrough/w.json", {
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

function view(opened: Array<[string, number]> = []): WalkthroughView {
  return new WalkthroughView({
    walkthrough,
    sources: new Map<string, string | null>([["a.ts", "one\ntwo\nthree\nfour\n"], ["missing.ts", null]]),
    subtitle: "org/repo/review-pr-7",
    onQuit: () => {},
    onOpen: (file, line) => opened.push([file, line]),
  });
}

function text(v: WalkthroughView): string {
  return v.render(120).map((l) => stripTerminalSequences(l)).join("\n");
}

test("rows list the overview, then each chunk followed by its sections", () => {
  assert.deepEqual(walkRows(walkthrough).map((r) => r.kind), ["overview", "chunk", "section", "section", "chunk", "section"]);
});

test("n/p read straight through and the main pane follows", () => {
  const v = view();
  assert.match(text(v), /Overall summary\./);
  v.handleInput("n");
  assert.match(text(v), /Chunk intro\./);
  v.handleInput("n");
  const alpha = text(v);
  assert.match(alpha, /Alpha prose with code\./);
  assert.match(alpha, /a\.ts:2-3 at abcdef1234/);
  assert.match(alpha, /2 ▎two/);
  v.handleInput("p");
  assert.equal(v.position, 1);
  for (let i = 0; i < 10; i++) v.handleInput("n");
  assert.equal(v.position, 5);
  assert.match(text(v), /missing\.ts not found at head/);
});

test("tab focuses the outline, enter jumps, esc returns", () => {
  const v = view();
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

test("e opens the section's file at its first line", () => {
  const opened: Array<[string, number]> = [];
  const v = view(opened);
  v.handleInput("e");
  v.handleInput("n");
  v.handleInput("n");
  v.handleInput("e");
  v.handleInput("n");
  v.handleInput("e");
  assert.deepEqual(opened, [["a.ts", 2]]);
});
