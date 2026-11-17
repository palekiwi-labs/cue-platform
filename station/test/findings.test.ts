import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { excerpt, FindingsView, isDismissed, loadRun, parseFinding, runDir, sortFindings } from "../src/findings.js";

const ADDRESS = "org/repo/review-pr-1/review/runs/123-abc";

function store(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "station-findings-"));
  const dir = join(root, ADDRESS);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(body));
  return root;
}

const RUN = {
  state: "completed",
  target: { kind: "pr", subject: "PR #1", refs: "master..x" },
  base: "b".repeat(40),
  head: "a".repeat(40),
  context: "org/repo/review-pr-1",
};

test("run addresses must point at review/runs/<run_id>", () => {
  assert.equal(runDir(ADDRESS, "/s"), `/s/${ADDRESS}`);
  assert.throws(() => runDir("org/repo/ctx/review/123-abc", "/s"));
  assert.throws(() => runDir("org/repo/ctx/review/runs/../x", "/s"));
});

test("findings sort by severity, keeping file order within one", () => {
  const f = (id: string, severity: string) => parseFinding({ id, severity }, 0);
  const sorted = sortFindings([f("a", "low"), f("b", "medium"), f("c", "low"), f("d", "critical"), f("e", "odd")]);
  assert.deepEqual(sorted.map((x) => x.id), ["d", "b", "a", "c", "e"]);
});

test("parseFinding tolerates missing fields", () => {
  const f = parseFinding({ title: "t", verification: { verdict: "verified" } }, 2);
  assert.equal(f.id, "finding-3");
  assert.equal(f.file, null);
  assert.deepEqual(f.verification, { verdict: "verified", reasoning: "" });
});

test("loadRun reads run.json and the verifier file", () => {
  const root = store({
    "run.json": RUN,
    "verifiers-opus.json": {
      summary: { by_severity: { low: 1, high: 1 } },
      analysis: {},
      findings: [
        { id: "finding-1", severity: "low", title: "l", file: "a.rb", line_start: 2, line_end: 3, message: "m" },
        { id: "finding-2", severity: "high", title: "h", message: "m" },
      ],
    },
  });
  const r = loadRun(ADDRESS, root);
  assert.equal(r.runId, "123-abc");
  assert.equal(r.head, RUN.head);
  assert.equal(r.subject, "PR #1");
  assert.equal(r.source, "verifiers-opus.json");
  assert.deepEqual(r.findings.map((f) => f.id), ["finding-2", "finding-1"]);
});

test("loadRun reports runs without verified findings", () => {
  const root = store({ "run.json": { ...RUN, state: "running" } });
  assert.throws(() => loadRun(ADDRESS, root), /no verified findings yet \(state: running\)/);
});

test("excerpt adds context lines and clamps to the file", () => {
  const src = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
  assert.deepEqual(excerpt(src, 2, 3), { start: 1, lines: ["l1", "l2", "l3", "l4", "l5", "l6"] });
  assert.deepEqual(excerpt(src, 9, 9).lines, ["l6", "l7", "l8", "l9", "l10"]);
});

test("view navigates findings and renders code from the head source", () => {
  const root = store({
    "run.json": RUN,
    "verifiers-opus.json": {
      summary: {},
      analysis: {},
      findings: [{ id: "finding-1", severity: "low", title: "Title one", file: "a.rb", line_start: 2, message: "Msg" }],
    },
  });
  const run = loadRun(ADDRESS, root);
  let quit = false;
  const opened: [string, number][] = [];
  const view = new FindingsView({
    run,
    sources: new Map([["a.rb", "x = 1\ny = 2\n"]]),
    onQuit: () => (quit = true),
    onOpen: (file, line) => opened.push([file, line]),
  });
  const text = (): string => view.render(120).map(stripTerminalSequences).join("\n");
  const shown = text();
  assert.match(shown, /Msg/);
  assert.match(shown, /2 ▎y = 2/);
  assert.match(shown, /finding 1\/1/);
  for (const [width, sideWidth] of [[120, 40], [80, 28], [180, 56], [120, 40]] as const) {
    const body = view.render(width).map(stripTerminalSequences).slice(2, -1);
    const divider = width - sideWidth - 1;
    for (const l of body) {
      assert.equal(l[divider], "│", l);
      assert.equal(l.length, width);
    }
    assert.ok(body.some((l) => l.slice(0, divider).includes("Msg")));
    assert.ok(body.some((l) => l.slice(divider + 1).includes("Title one")));
  }
  view.handleInput("e");
  assert.deepEqual(opened, [["a.rb", 2]]);
  view.handleInput("q");
  assert.equal(quit, true);
});

test("dismissed findings are marked in the list", () => {
  assert.equal(isDismissed(parseFinding({ dismiss_reason: "refuted" }, 0)), true);
  assert.equal(isDismissed(parseFinding({ status: "dismissed" }, 0)), true);
  assert.equal(isDismissed(parseFinding({ status: "applied" }, 0)), false);
  const root = store({
    "run.json": RUN,
    "verifiers-opus.json": {
      findings: [
        { id: "finding-1", severity: "high", title: "Kept", file: "a.rb", line_start: 1 },
        { id: "finding-2", severity: "high", title: "Gone", file: "a.rb", line_start: 2, dismiss_reason: "refuted" },
      ],
    },
  });
  const view = new FindingsView({ run: loadRun(ADDRESS, root), sources: new Map(), onQuit: () => {}, onOpen: () => {} });
  const side = view.render(120).map((l) => stripTerminalSequences(l).slice(81));
  assert.ok(side.some((l) => /HIGH {2}dismissed {2}a\.rb/.test(l)));
  assert.equal(side.filter((l) => l.includes("dismissed")).length, 1);
});
