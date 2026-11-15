import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { age, PrsView } from "../src/prs.js";
import type { PrSummary } from "../src/source.js";

const pr = (n: number, requested: string[] = []): PrSummary => ({
  number: n,
  title: `title ${n}`,
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
  const v = new PrsView({ repo: "o/r", onQuit: () => {}, onOpen: (p) => opened.push(p.number), onRefresh: () => {} });
  v.setPrs([pr(1), pr(2, ["me"])], "me");
  const lines = v.render(100).map(stripTerminalSequences);
  assert.ok(lines.every((l) => visibleWidth(l) <= 100));
  assert.ok(lines.some((l) => l.includes("#2") && l.includes("draft") && l.includes("●")));
  assert.ok(lines[1]?.includes("1 requesting me"));
  v.handleInput("j");
  v.handleInput("\r");
  assert.deepEqual(opened, [2]);
});
