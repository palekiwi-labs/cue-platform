import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { age, layoutRows, type PrSort, PrsView, sortPickerText, sortPrs, treeRows } from "../src/prs.js";
import type { PrSummary } from "../src/source.js";

const hoursAgo = (h: number): string => new Date(Date.now() - h * 3600_000).toISOString();

const pr = (n: number, requested: string[] = []): PrSummary => ({
  number: n,
  title: `title ${n}`,
  url: `https://github.com/o/r/pull/${n}`,
  author: "alice",
  baseRef: "main",
  headRef: `b${n}`,
  defaultBranch: "main",
  isDraft: n === 2,
  createdAt: hoursAgo(100 + n),
  updatedAt: hoursAgo(n),
  reviewDecision: "",
  requested,
});
test("age buckets", () => {
  const now = Date.parse("2026-01-10T00:00:00Z");
  assert.equal(age("2026-01-09T23:30:00Z", now), "30m");
  assert.equal(age("2026-01-09T21:00:00Z", now), "3h");
  assert.equal(age("2026-01-07T00:00:00Z", now), "3d");
});

test("list renders, navigates and opens", () => {
  const opened: number[] = [];
  const v = new PrsView({ repo: "o/r", onQuit: () => {}, onOpen: (p) => opened.push(p.number), onCheckout: () => {}, onLaunch: () => {}, onRefresh: () => {}, onCopy: () => {}, onPickSort: () => {} });
  v.setPrs([pr(1), pr(2, ["me"])], "me");
  const lines = v.render(100).map(stripTerminalSequences);
  assert.ok(lines.every((l) => visibleWidth(l) <= 100));
  assert.ok(lines.some((l) => l.includes("#2") && l.includes("●")));
  assert.ok(lines[1]?.includes("1 requesting me"));
  v.handleInput("j");
  v.handleInput("\r");
  assert.deepEqual(opened, [2]);
});

test("j/k and arrows wrap around the list ends and keep the selection visible", () => {
  const v = new PrsView({ repo: "o/r", onQuit: () => {}, onOpen: () => {}, onCheckout: () => {}, onLaunch: () => {}, onRefresh: () => {}, onCopy: () => {}, onPickSort: () => {} });
  for (const key of ["j", "k", "\x1b[A", "\x1b[B"]) v.handleInput(key);
  assert.equal(v.selected(), undefined);
  v.setPrs([pr(1)], "me");
  for (const key of ["j", "k", "\x1b[A", "\x1b[B"]) {
    v.handleInput(key);
    assert.equal(v.selected()?.number, 1);
  }
  const rows = process.stdout.rows;
  process.stdout.rows = 8;
  try {
    v.setPrs(Array.from({ length: 30 }, (_, i) => pr(i + 1)), "me");
    const body = (): string[] => v.render(100).map(stripTerminalSequences).slice(2, -1);
    const shown = (n: number): boolean => body().some((l) => l.includes(`#${n} `));
    assert.equal(v.selected()?.number, 1);
    for (const up of ["k", "\x1b[A"]) {
      v.handleInput(up);
      assert.equal(v.selected()?.number, 30);
      assert.ok(shown(30));
      assert.ok(!shown(1));
      v.handleInput(up === "k" ? "j" : "\x1b[B");
      assert.equal(v.selected()?.number, 1);
      assert.ok(shown(1));
      assert.ok(!shown(30));
    }
    v.handleInput("G");
    v.handleInput("\x04");
    assert.equal(v.selected()?.number, 30);
    v.handleInput("g");
    v.handleInput("\x15");
    assert.equal(v.selected()?.number, 1);
  } finally {
    process.stdout.rows = rows;
  }
});

test("y copies the selected URL, h copies a Markdown link, with notices", () => {
  const copied: string[] = [];
  let fail = false;
  const v = new PrsView({
    repo: "o/r",
    onQuit: () => {},
    onOpen: () => {},
    onCheckout: () => {},
    onLaunch: () => {},
    onRefresh: () => {},
    onPickSort: () => {},
    onCopy: (text) => {
      if (fail) throw new Error("no terminal");
      copied.push(text);
    },
  });
  const footer = (): string => stripTerminalSequences(v.render(200).at(-1) ?? "");
  assert.match(footer(), /y copy url {2}h copy md/);
  v.handleInput("y");
  assert.match(footer(), /copy failed: no pull request selected/);
  v.setPrs([pr(1), pr(2)], "me");
  v.handleInput("j");
  v.handleInput("y");
  v.handleInput("h");
  assert.deepEqual(copied, ["https://github.com/o/r/pull/2", "[title 2](https://github.com/o/r/pull/2)"]);
  assert.match(footer(), /copied \[title 2\]\(https:\/\/github.com\/o\/r\/pull\/2\)/);
  assert.ok(v.render(80).every((l) => visibleWidth(l) <= 80));
  v.handleInput("k");
  assert.doesNotMatch(footer(), /copied/);
  fail = true;
  v.handleInput("y");
  assert.match(footer(), /copy failed: no terminal/);
  fail = false;
  v.setPrs([{ ...pr(3), url: "" }], "me");
  v.handleInput("h");
  assert.match(footer(), /copy failed: #3 has no URL/);
  assert.equal(copied.length, 2);
});

const at = (n: number, author: string, created: number, updated: number): PrSummary => ({
  ...pr(n),
  author,
  createdAt: `2026-01-0${created}T00:00:00Z`,
  updatedAt: `2026-02-0${updated}T00:00:00Z`,
});

test("sortPrs orders by update, creation and author with deterministic ties", () => {
  const prs = [at(1, "bob", 1, 5), at(2, "alice", 3, 2), at(3, "Bob", 2, 7), at(4, "alice", 4, 2), at(5, "carol", 4, 1)];
  const order = (sort: PrSort): number[] => sortPrs(prs, sort).map((p) => p.number);
  assert.deepEqual(order("updated"), [3, 1, 4, 2, 5]);
  assert.deepEqual(order("created"), [5, 4, 2, 3, 1]);
  assert.deepEqual(order("author"), [4, 2, 3, 1, 5]);
  assert.deepEqual(prs.map((p) => p.number), [1, 2, 3, 4, 5]);
  assert.deepEqual(sortPrs([...prs].reverse(), "author").map((p) => p.number), order("author"));
});

test("list defaults to recently updated and s picks a sort keeping the selection", () => {
  const picks: PrSort[] = [];
  let choose: ((sort: PrSort) => void) | undefined;
  const v = new PrsView({
    repo: "o/r",
    onQuit: () => {},
    onOpen: () => {},
    onCheckout: () => {},
    onLaunch: () => {},
    onRefresh: () => {},
    onCopy: () => {},
    onPickSort: (current, c) => {
      picks.push(current);
      choose = c;
    },
  });
  const footer = (): string => stripTerminalSequences(v.render(200).at(-1) ?? "");
  v.setPrs([at(1, "bob", 1, 5), at(2, "alice", 3, 2), at(3, "carol", 2, 7)], "me");
  assert.equal(v.selected()?.number, 3);
  assert.match(footer(), /s sort/);
  assert.match(footer(), /sort: recently updated {2}1\/3/);
  v.handleInput("j");
  assert.equal(v.selected()?.number, 1);
  v.handleInput("s");
  assert.deepEqual(picks, ["updated"]);
  choose?.("author");
  assert.equal(v.sortBy(), "author");
  assert.equal(v.selected()?.number, 1);
  assert.match(footer(), /sort: author {2}2\/3/);
  v.handleInput("s");
  assert.deepEqual(picks, ["updated", "author"]);
  choose?.("created");
  assert.equal(v.selected()?.number, 1);
  assert.match(footer(), /sort: newest created {2}3\/3/);
  v.setPrs([at(4, "dan", 9, 1), at(1, "bob", 1, 5)], "me");
  assert.equal(v.selected()?.number, 1);
  assert.match(footer(), /sort: newest created {2}2\/2/);
});

test("sort picker marks the active sort and lists its keys", () => {
  const lines = stripTerminalSequences(sortPickerText("created")).split("\n");
  assert.deepEqual(lines, ["  u  recently updated", "● c  newest created", "  a  author"]);
});

const stacked = (n: number, base: string, updated: number, created = updated): PrSummary => ({
  ...pr(n),
  baseRef: base,
  headRef: `b${n}`,
  createdAt: `2026-01-0${created}T00:00:00Z`,
  updatedAt: `2026-02-0${updated}T00:00:00Z`,
});

const shape = (rows: { pr: PrSummary; depth: number; guide: string }[]): string[] =>
  rows.map((r) => `${r.guide}${r.pr.number}`);

test("treeRows nests stacks under their parent and orders roots and siblings by the sort", () => {
  const prs = [
    stacked(1, "main", 1, 9),
    stacked(2, "b1", 5, 1),
    stacked(3, "b1", 3, 2),
    stacked(4, "b2", 2),
    stacked(5, "main", 4, 1),
    stacked(6, "gone", 9, 1),
  ];
  assert.deepEqual(shape(treeRows(prs, "updated")), ["6", "5", "1", "├ 2", "│ └ 4", "└ 3"]);
  assert.deepEqual(shape(treeRows(prs, "created")), ["1", "├ 3", "└ 2", "  └ 4", "6", "5"]);
  assert.deepEqual(treeRows(prs, "updated").map((r) => r.depth), [0, 0, 0, 1, 2, 1]);
});

test("treeRows lists every PR once, cycles included", () => {
  const a = { ...stacked(1, "b2", 1), headRef: "b1" };
  const b = { ...stacked(2, "b1", 2), headRef: "b2" };
  const rows = treeRows([a, b, stacked(3, "main", 3)], "updated");
  assert.deepEqual(rows.map((r) => r.pr.number).sort(), [1, 2, 3]);
  assert.equal(new Set(rows.map((r) => r.pr.number)).size, 3);
});

test("flat layout keeps the global sort", () => {
  const prs = [stacked(1, "main", 1), stacked(2, "b1", 5), stacked(3, "main", 3)];
  assert.deepEqual(shape(layoutRows(prs, "updated", "flat")), ["2", "3", "1"]);
  assert.deepEqual(shape(layoutRows(prs, "updated", "tree")), ["3", "1", "└ 2"]);
});

test("t toggles the tree keeping the selection across toggles and refreshes", () => {
  const v = new PrsView({ repo: "o/r", onQuit: () => {}, onOpen: () => {}, onCheckout: () => {}, onLaunch: () => {}, onRefresh: () => {}, onCopy: () => {}, onPickSort: () => {} });
  const prs = [stacked(1, "main", 1), stacked(2, "b1", 5), stacked(3, "main", 3)];
  v.setPrs(prs, "me");
  assert.equal(v.layoutMode(), "flat");
  v.handleInput("G");
  assert.equal(v.selected()?.number, 1);
  v.handleInput("t");
  assert.equal(v.layoutMode(), "tree");
  assert.equal(v.selected()?.number, 1);
  v.handleInput("j");
  assert.equal(v.selected()?.number, 2);
  v.handleInput("j");
  assert.equal(v.selected()?.number, 3);
  v.handleInput("k");
  assert.equal(v.selected()?.number, 2);
  v.setPrs([...prs, stacked(4, "b2", 9)], "me");
  assert.equal(v.layoutMode(), "tree");
  assert.equal(v.selected()?.number, 2);
  const lines = v.render(200).map(stripTerminalSequences);
  assert.ok(lines.some((l) => l.includes("#2     └ title 2")));
  assert.ok(lines.some((l) => l.includes("#4       └ title 4")));
  assert.match(lines.at(-1) ?? "", /t tree/);
  assert.match(lines.at(-1) ?? "", /tree {2}sort: recently updated/);
  v.handleInput("t");
  assert.equal(v.layoutMode(), "flat");
  assert.equal(v.selected()?.number, 2);
});

test("c asks to check out the selected PR", () => {
  const out: number[] = [];
  const v = new PrsView({ repo: "o/r", onQuit: () => {}, onOpen: () => {}, onCheckout: (p) => out.push(p.number), onLaunch: () => {}, onRefresh: () => {}, onCopy: () => {}, onPickSort: () => {} });
  v.handleInput("c");
  assert.deepEqual(out, []);
  v.setPrs([pr(1), pr(2)], "me");
  v.handleInput("j");
  v.handleInput("c");
  assert.deepEqual(out, [2]);
  assert.match(stripTerminalSequences(v.render(200).at(-1) ?? ""), /c checkout/);
});

test("L asks to launch for the selected PR", () => {
  const out: number[] = [];
  const v = new PrsView({ repo: "o/r", onQuit: () => {}, onOpen: () => {}, onCheckout: () => {}, onLaunch: (p) => out.push(p.number), onRefresh: () => {}, onCopy: () => {}, onPickSort: () => {} });
  v.handleInput("L");
  assert.deepEqual(out, []);
  v.setPrs([pr(1), pr(2)], "me");
  v.handleInput("j");
  v.handleInput("L");
  assert.deepEqual(out, [2]);
  assert.match(stripTerminalSequences(v.render(200).at(-1) ?? ""), /L launch/);
});
