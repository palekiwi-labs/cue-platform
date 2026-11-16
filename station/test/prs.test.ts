import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { age, PrsView } from "../src/prs.js";
import type { PrSummary } from "../src/source.js";

const pr = (n: number, requested: string[] = []): PrSummary => ({
  number: n,
  title: `title ${n}`,
  url: `https://github.com/o/r/pull/${n}`,
  author: "alice",
  headRefName: `b${n}`,
  isDraft: n === 2,
  updatedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
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
  const v = new PrsView({ repo: "o/r", onQuit: () => {}, onOpen: (p) => opened.push(p.number), onRefresh: () => {}, onCopy: () => {} });
  v.setPrs([pr(1), pr(2, ["me"])], "me");
  const lines = v.render(100).map(stripTerminalSequences);
  assert.ok(lines.every((l) => visibleWidth(l) <= 100));
  assert.ok(lines.some((l) => l.includes("#2") && l.includes("●")));
  assert.ok(lines[1]?.includes("1 requesting me"));
  v.handleInput("j");
  v.handleInput("\r");
  assert.deepEqual(opened, [2]);
});

test("y copies the selected URL, h copies a Markdown link, with notices", () => {
  const copied: string[] = [];
  let fail = false;
  const v = new PrsView({
    repo: "o/r",
    onQuit: () => {},
    onOpen: () => {},
    onRefresh: () => {},
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
