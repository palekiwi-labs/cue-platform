import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  deriveStatus,
  parseWindows,
  type PrReviewStatus,
  prReviewStatus,
  ReviewStatuses,
  type StatusInput,
  type Windows,
} from "../src/pr-status.js";
import { previewLines, PrsView, STATUS_WIDTH, statusSlot } from "../src/prs.js";
import type { PrSummary } from "../src/source.js";

const win = (context: string, run: string, state: string, busy = true) => ({ context, run, state, busy });

const input = (over: Partial<StatusInput>): StatusInput => ({
  context: "review-pr-7",
  runs: [],
  windows: { ok: true, windows: [] },
  findings: () => null,
  walkthroughs: [],
  ...over,
});

test("parseWindows keeps review windows and asks whether each pane runs a child", () => {
  const busy = (pid: string) => pid === "11";
  assert.deepEqual(parseWindows("review-pr-7\t100\trunning\t11\nreview-pr-8\t200\t\t12\n\t\t\t13\n", busy), [
    win("review-pr-7", "100", "running"),
    win("review-pr-8", "200", "", false),
  ]);
});

test("a run with a live window is in progress", () => {
  const s = deriveStatus(input({
    runs: [{ runId: "100", state: "running", verified: false }],
    windows: { ok: true, windows: [win("review-pr-7", "100", "running")] },
  }));
  assert.equal(s.inProgress, true);
  assert.equal(s.runs[0]?.state, "in progress");
  assert.equal(s.latest, null);
});

test("a running run without a live window is interrupted", () => {
  const s = deriveStatus(input({ runs: [{ runId: "100", state: "running", verified: false }] }));
  assert.equal(s.inProgress, false);
  assert.equal(s.runs[0]?.state, "interrupted");
  assert.equal(s.latest, "interrupted");
});

test("a window whose pane runs no child is not live", () => {
  const s = deriveStatus(input({
    runs: [{ runId: "100", state: "completed", verified: false }],
    windows: { ok: true, windows: [win("review-pr-7", "100", "", false)] },
  }));
  assert.equal(s.inProgress, false);
  assert.equal(s.runs[0]?.state, "completed");
});

test("an unreadable tmux leaves running runs unknown", () => {
  const s = deriveStatus(input({ runs: [{ runId: "100", state: "running", verified: false }], windows: { ok: false } }));
  assert.equal(s.runs[0]?.state, "unknown");
  assert.equal(s.inProgress, false);
});

test("a launched window before run.json counts as in progress", () => {
  const s = deriveStatus(input({
    runs: [{ runId: "90", state: "completed", verified: true }],
    windows: { ok: true, windows: [win("review-pr-7", "", "")] },
  }));
  assert.equal(s.inProgress, true);
  assert.equal(s.latest, "completed");
});

test("windows of other contexts are ignored", () => {
  const s = deriveStatus(input({ windows: { ok: true, windows: [win("review-pr-70", "", "running")] } }));
  assert.equal(s.inProgress, false);
});

test("findings are counted for verified runs only", () => {
  const s = deriveStatus(input({
    runs: [{ runId: "200", state: "completed", verified: true }, { runId: "100", state: "failed", verified: false }],
    findings: (runId) => ({ runId, open: 2, total: 5 }),
  }));
  assert.deepEqual(s.findings, [{ runId: "200", open: 2, total: 5 }]);
});

function store(): string {
  const root = mkdtempSync(join(tmpdir(), "pr-status-"));
  const ctx = join(root, "o/r/review-pr-7/review");
  const run = join(ctx, "runs/1700000000");
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "run.json"), JSON.stringify({ state: "completed", head: "abc" }));
  writeFileSync(join(run, "verifiers-x.json"), JSON.stringify({ findings: [
    { id: "a", status: "open" },
    { id: "b", status: "applied" },
    { id: "c", status: "dismissed" },
    { id: "d", verification: { verdict: "refuted" } },
    { id: "e" },
  ] }));
  mkdirSync(join(ctx, "walkthrough"), { recursive: true });
  writeFileSync(join(ctx, "walkthrough/w1.json"), JSON.stringify({ title: "t" }));
  return root;
}

test("prReviewStatus reads runs, open findings and walkthroughs from the store", () => {
  const root = store();
  const s = prReviewStatus("o/r", 7, { ok: true, windows: [] }, root);
  assert.ok(s !== null);
  assert.equal(s.latest, "completed");
  assert.deepEqual(s.findings, [{ runId: "1700000000", open: 2, total: 5 }]);
  assert.deepEqual(s.walkthroughs, ["w1"]);
  assert.equal(prReviewStatus("o/r", 8, { ok: true, windows: [] }, root), null);
});

const status = (over: Partial<PrReviewStatus>): PrReviewStatus => ({
  runs: [], inProgress: false, latest: null, findings: [], walkthroughs: [], ...over,
});

test("status slot has a fixed width and shows run, open findings and walkthrough", () => {
  const plain = (s: PrReviewStatus | undefined) => stripTerminalSequences(statusSlot(s));
  assert.equal(plain(undefined), " ".repeat(STATUS_WIDTH));
  assert.equal(plain(status({ inProgress: true })), "◐       ".slice(0, STATUS_WIDTH));
  const done = status({ latest: "completed", findings: [{ runId: "1", open: 3, total: 4 }], walkthroughs: ["w"] });
  assert.equal(plain(done), "● 3   w");
  assert.equal(plain(status({ latest: "completed", findings: [{ runId: "1", open: 120, total: 130 }] })), "● 99+  ");
  for (const s of [undefined, status({ inProgress: true }), done]) assert.equal(visibleWidth(statusSlot(s)), STATUS_WIDTH);
});

const pr = (n: number): PrSummary => ({
  number: n, title: `title ${n}`, url: "", author: "alice", baseRef: "main", headRef: `b${n}`, defaultBranch: "main",
  isDraft: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reviewDecision: "", requested: [],
});

test("preview lists runs with outcomes and findings, and walkthroughs", () => {
  const s = status({
    latest: "completed",
    runs: [{ runId: "200", state: "completed", verified: true }, { runId: "100", state: "interrupted", verified: false }],
    findings: [{ runId: "200", open: 1, total: 3 }],
    walkthroughs: ["w1"],
  });
  const lines = previewLines(pr(7), s, Date.now()).map(stripTerminalSequences);
  assert.ok(lines[0]?.includes("#7"));
  assert.ok(lines.some((l) => l.includes("200") && l.includes("completed") && l.includes("1/3 findings open")));
  assert.ok(lines.some((l) => l.includes("100") && l.includes("interrupted") && l.includes("not verified")));
  assert.ok(lines.some((l) => l.includes("w w1")));
  assert.ok(previewLines(pr(8), undefined, Date.now()).map(stripTerminalSequences)[1]?.includes("no reviews"));
});

test("list rows carry the status slot and the preview scrolls with shift arrows", () => {
  const rows = process.stdout.rows;
  process.stdout.rows = 24;
  try {
    const v = new PrsView({ repo: "o/r", onQuit: () => {}, onOpen: () => {}, onCheckout: () => {}, onLaunch: () => {}, onRefresh: () => {}, onCopy: () => {}, onPickSort: () => {} });
    v.setPrs([pr(7)], "me");
    const many = Array.from({ length: 20 }, (_, i) => ({ runId: String(100 + i), state: "completed" as const, verified: false }));
    v.setStatuses(new Map([[7, status({ latest: "completed", runs: many })]]));
    const out = () => v.render(100).map(stripTerminalSequences);
    assert.ok(out().some((l) => l.includes("#7") && l.includes("●")));
    assert.ok(out().some((l) => l.startsWith(" review status")));
    const first = out().find((l) => l.startsWith(" review status"));
    v.handleInput("\x1b[1;2B");
    const second = out().find((l) => l.startsWith(" review status"));
    assert.notEqual(first, second);
    assert.ok(second?.includes("2-"));
    v.handleInput("\x1b[1;2A");
    assert.equal(out().find((l) => l.startsWith(" review status")), first);
  } finally {
    process.stdout.rows = rows;
  }
});

test("ReviewStatuses polls only while a review is in progress", async () => {
  let live = true;
  const reads: number[] = [];
  let set = new Map<number, PrReviewStatus>();
  const windows: Windows = { ok: true, windows: [] };
  const s = new ReviewStatuses(
    { numbers: () => [1, 2], setStatuses: (m) => (set = m) },
    "o/r",
    () => {},
    (n) => {
      reads.push(n);
      return n === 1 ? status({ inProgress: live }) : null;
    },
    () => windows,
    5,
  );
  s.refresh();
  assert.deepEqual([...set.keys()], [1]);
  assert.equal(s.polling(), true);
  live = false;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.polling(), false);
  assert.equal(reads.length, 4);
  s.dispose();
});
