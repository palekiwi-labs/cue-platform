import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { FeedbackTab, type FeedbackTabDeps, when } from "../src/feedback-view.js";
import type { ConversationEntry, FeedbackSnapshot } from "../src/github-feedback.js";
import type { PopupContent } from "../src/popup.js";
import type { PrTabHost } from "../src/pr-tabs.js";
import { comment, gitFixture, type GitFixture, LEFT_HUNK, RIGHT_HUNK, snapshot, thread } from "./feedback-fixture.js";

const entry: ConversationEntry = {
  kind: "review", id: "R9", database_id: "9", author: { login: "carol", type: "User", association: "MEMBER" },
  body: "Looks good overall", state: "APPROVED", created_at: "2025-01-02T10:00:00Z", updated_at: null,
  last_edited_at: null, url: "https://github.com/org/repo/pull/7#pullrequestreview-9", commit: null,
  is_minimized: false, minimized_reason: null,
};

function setup(f: GitFixture, deps: Partial<FeedbackTabDeps> = {}) {
  const popups: { content: PopupContent; keys?: Record<string, () => void> }[] = [];
  const opened: string[] = [];
  let renders = 0;
  const host: PrTabHost = {
    repo: f.repo, repoSlug: "org/repo", pr: 7, prHead: f.head, prWorktree: f.repo, chosen: new Map(),
    onQuit: () => {},
    openPath: (cwd, path, line, base) => opened.push(`${cwd === f.repo ? "pr" : cwd}|${path}:${line}|${base ?? "-"}`),
    showPopup: (content, _d, keys) => popups.push({ content, keys }),
    requestRender: () => renders++,
  };
  const saved: FeedbackSnapshot[] = [];
  const fetchCalls: number[] = [];
  const full: FeedbackTabDeps = {
    load: () => null,
    fetch: async () => {
      fetchCalls.push(1);
      throw new Error("not stubbed");
    },
    save: (s) => saved.push(s),
    fetchCommits: async () => {},
    ...deps,
  };
  return { host, tab: new FeedbackTab(host, full), popups, opened, saved, fetchCalls, renders: () => renders };
}

function text(tab: { render(w: number): string[] }): string {
  return tab.render(200).map(stripTerminalSequences).join("\n");
}

const tick = () => new Promise((r) => setImmediate(r));

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 20));
}

function feedback(f: GitFixture): FeedbackSnapshot {
  return snapshot(f, [
    thread({ id: "T1", line: 7, original_line: 5, is_resolved: true, resolved_by: "bob" }, { original_commit: f.first, diff_hunk: RIGHT_HUNK, body: "rename this" }),
    thread({ id: "T2", diff_side: "LEFT", is_outdated: true, original_line: 8, comments: [] }),
    thread({ id: "T3", diff_side: "LEFT", line: 8, original_line: 8 }, { original_commit: f.first, diff_hunk: LEFT_HUNK, body: "why delete?" }),
  ], { conversation: [entry] });
}

test("entering the tab never fetches; R fetches, saves and shows threads and conversation", async () => {
  const f = gitFixture();
  try {
    const s = feedback(f);
    let resolve: (v: FeedbackSnapshot) => void = () => {};
    const ui = setup(f, { fetch: () => new Promise((r) => (resolve = r)) });
    assert.match(text(ui.tab), /no GitHub feedback fetched for #7 yet/);
    ui.tab.handleInput("R");
    assert.match(text(ui.tab), /fetching review threads/);
    ui.tab.handleInput("R");
    resolve(s);
    await tick();
    const out = text(ui.tab);
    assert.equal(ui.saved.length, 1);
    assert.match(out, /github  #7  Rename things/);
    assert.match(out, /3 threads \(2 unresolved\)/);
    assert.match(out, /Code threads 3/);
    assert.match(out, /Conversation 1/);
    assert.match(out, /a\.ts:7/);
    assert.match(out, /state unresolved/);
    assert.match(out, /Captured diff/);
    assert.match(out, /-l8/);
    assert.match(out, /why delete\?/);
    assert.ok(ui.renders() > 0);
  } finally {
    f.cleanup();
  }
});

test("a saved snapshot loads on entry; failed fetches keep it and report the error", async () => {
  const f = gitFixture();
  try {
    const ui = setup(f, { load: () => feedback(f), fetch: async () => { throw new Error("rate limited"); } });
    assert.match(text(ui.tab), /Code threads 3/);
    ui.tab.handleInput("j");
    ui.tab.handleInput("R");
    await tick();
    assert.match(ui.popups.at(-1)?.content.text ?? "", /fetch failed: rate limited/);
    assert.match(text(ui.tab), /showing the previous snapshot/);
    assert.match(text(ui.tab), /item 2\/4/);

    const empty = setup(f, { fetch: async () => { throw new Error("gh: not logged in"); } });
    empty.tab.handleInput("R");
    await tick();
    assert.match(text(empty.tab), /fetch failed: gh: not logged in/);
    const broken = setup(f, { load: () => { throw new Error("bad json"); } });
    assert.match(text(broken.tab), /saved snapshot unreadable: bad json/);
  } finally {
    f.cleanup();
  }
});

test("refresh keeps the selected item by id", async () => {
  const f = gitFixture();
  try {
    const s = feedback(f);
    const reordered = { ...s, threads: [s.threads[2]!, s.threads[0]!, s.threads[1]!] };
    const ui = setup(f, { load: () => s, fetch: async () => reordered });
    ui.tab.handleInput("s");
    ui.popups.at(-1)?.keys?.d?.();
    ui.tab.handleInput("G");
    assert.match(text(ui.tab), /item 4\/4/);
    ui.tab.handleInput("k");
    ui.tab.handleInput("R");
    await tick();
    assert.match(text(ui.tab), /item 1\/4/);
    assert.match(text(ui.tab), /why delete\?/);
  } finally {
    f.cleanup();
  }
});

test("e opens resolved thread locations and explains what it cannot open", async () => {
  const f = gitFixture();
  try {
    const fetched: string[][] = [];
    const ui = setup(f, { load: () => feedback(f), fetchCommits: async (shas) => void fetched.push(shas) });
    ui.tab.handleInput("e");
    await until(() => ui.opened.length === 1);
    const worktree = join(f.repo, "worktrees", "review", "pr-7-findings");
    assert.deepEqual(ui.opened, [`${worktree}|a.ts:8|-`]);
    assert.equal(f.git("-C", worktree, "rev-parse", "HEAD"), f.base);

    ui.tab.handleInput("j");
    ui.tab.handleInput("e");
    await tick();
    assert.match(ui.popups.at(-1)?.content.text ?? "", /cannot open a\.ts:8: the thread has no comments/);
    assert.match(ui.popups.at(-1)?.content.text ?? "", /captured diff stays/);

    ui.tab.handleInput("j");
    ui.tab.handleInput("e");
    await until(() => ui.opened.length === 2);
    assert.equal(ui.opened.at(-1), `pr|a.ts:7|${f.base}`);

    ui.tab.handleInput("j");
    ui.tab.handleInput("e");
    assert.match(ui.popups.at(-1)?.content.text ?? "", /general PR comments have no code location/);
    assert.equal(ui.opened.length, 2);
    assert.deepEqual(fetched, []);
  } finally {
    f.cleanup();
  }
});

test("e fetches missing commits first and asks before opening a file with local changes", async () => {
  const f = gitFixture();
  try {
    const missing = "e".repeat(40);
    const s = snapshot(f, [
      thread({ id: "M", is_outdated: true, original_line: 5 }, { original_commit: missing, diff_hunk: RIGHT_HUNK }),
      thread({ id: "D", line: 7 }, { diff_hunk: RIGHT_HUNK }),
    ]);
    const fetched: string[][] = [];
    const ui = setup(f, { load: () => s, fetchCommits: async (shas) => void fetched.push(shas) });
    ui.tab.handleInput("e");
    await until(() => ui.popups.length === 1);
    assert.deepEqual(fetched, [[missing]]);
    assert.match(ui.popups.at(-1)?.content.text ?? "", /not in the local repository and could not be fetched/);

    writeFileSync(join(f.repo, "a.ts"), "dirty\n");
    ui.tab.handleInput("j");
    ui.tab.handleInput("e");
    await until(() => ui.popups.length === 2);
    const ask = ui.popups.at(-1);
    assert.match(ask?.content.text ?? "", /a\.ts has uncommitted changes/);
    assert.equal(ui.opened.length, 0);
    ask?.keys?.y?.();
    assert.deepEqual(ui.opened, [`pr|a.ts:7|${f.base}`]);
  } finally {
    f.cleanup();
  }
});

const CTRL_DOWN = "\x1b[1;5B";
const CTRL_UP = "\x1b[1;5A";

function narrow(tab: { render(w: number): string[] }, width = 120): string[] {
  return tab.render(width).map(stripTerminalSequences);
}

const SIDE_LABEL = /PR version|base version|unknown side|diff:|new \(head\)|old \(base\)|side new|old side/;

test("no diff side label is shown and general comments carry no open hint", () => {
  const f = gitFixture();
  try {
    const ui = setup(f, { load: () => feedback(f) });
    let out = text(ui.tab);
    assert.match(out, /state unresolved/);
    assert.doesNotMatch(out, SIDE_LABEL);
    ui.tab.handleInput("j");
    out = text(ui.tab);
    assert.match(out, /outdated/);
    assert.doesNotMatch(out, SIDE_LABEL);
    ui.tab.handleInput("j");
    out = text(ui.tab);
    assert.match(out, /state resolved by bob/);
    assert.doesNotMatch(out, SIDE_LABEL);
    ui.tab.handleInput("G");
    out = text(ui.tab);
    assert.match(out, /Looks good overall/);
    assert.doesNotMatch(out, /no code location to open/);
  } finally {
    f.cleanup();
  }
});

test("y copies the selected thread or comment link and reports failures", () => {
  const f = gitFixture();
  try {
    const copied: string[] = [];
    const ui = setup(f, { load: () => feedback(f) });
    ui.host.onCopy = (t) => void copied.push(t);
    ui.tab.handleInput("y");
    assert.deepEqual(copied, ["https://github.com/org/repo/pull/7#discussion_r1"]);
    assert.match(text(ui.tab), /link copied/);
    assert.doesNotMatch(text(ui.tab), /https?:\/\//);
    ui.tab.handleInput("j");
    assert.doesNotMatch(text(ui.tab), /copied/);
    ui.tab.handleInput("y");
    assert.match(text(ui.tab), /copy failed: no GitHub link for this item/);
    ui.tab.handleInput("G");
    assert.doesNotMatch(text(ui.tab), /https?:\/\//);
    ui.tab.handleInput("y");
    assert.equal(copied.at(-1), entry.url);
    assert.match(text(ui.tab), /link copied/);
    assert.doesNotMatch(text(ui.tab), /https?:\/\//);

    ui.host.onCopy = () => {
      throw new Error("terminal refused");
    };
    ui.tab.handleInput("y");
    assert.match(text(ui.tab), /copy failed: terminal refused/);
    ui.host.onCopy = undefined;
    ui.tab.handleInput("y");
    assert.match(text(ui.tab), /copy failed: no clipboard available/);
    assert.equal(ui.popups.length, 0);
  } finally {
    f.cleanup();
  }
});

function sortable(f: GitFixture): FeedbackSnapshot {
  const at = (id: string, t: string) => ({ id, created_at: t });
  const by = (login: string) => ({ ...entry.author, login });
  const older: ConversationEntry = { ...entry, id: "E1", kind: "comment", state: null, author: by("erin"), created_at: "2025-01-01T00:00:00Z" };
  const newer: ConversationEntry = { ...entry, id: "E2", kind: "comment", state: null, author: by("frank"), created_at: "2025-01-05T00:00:00Z" };
  return snapshot(f, [
    thread({ id: "A", path: "z.ts", line: 3, is_resolved: true }, at("a", "2025-01-04T00:00:00Z")),
    thread({ id: "B", path: "b.ts", line: 9 }, at("b", "2025-01-01T00:00:00Z")),
    thread({ id: "C", path: "b.ts", line: 2 }, at("c", "2025-01-03T00:00:00Z")),
    thread({ id: "D", path: "a.ts", line: 1, is_resolved: true }, at("d", "2025-01-06T00:00:00Z")),
  ], { conversation: [older, newer] });
}

function sideRows(tab: { render(w: number): string[] }, width = 200): string[] {
  return tab.render(width).map(stripTerminalSequences).slice(2, -1).map((l) => l.slice(l.indexOf("│") + 1));
}

const ALPHA = "z.ts:3";
const BRAVO = "b.ts:9";
const CHARLIE = "b.ts:2";
const DELTA = "a.ts:1";
const FIRST = "erin";
const SECOND = "frank";

function order(tab: { render(w: number): string[] }): string[] {
  const side = sideRows(tab).join("\n");
  return [ALPHA, BRAVO, CHARLIE, DELTA, FIRST, SECOND].map((w) => [side.indexOf(w), w] as const).sort((a, b) => a[0] - b[0]).map(([, w]) => w);
}

test("s picks a sort; the selection follows the item and the sort survives refresh", async () => {
  const f = gitFixture();
  try {
    const s = sortable(f);
    const ui = setup(f, { load: () => s, fetch: async () => s });
    assert.deepEqual(order(ui.tab), [CHARLIE, BRAVO, DELTA, ALPHA, SECOND, FIRST]);
    assert.match(text(ui.tab), /s sort/);
    assert.match(text(ui.tab), /sort: unresolved first/);
    const pick = (key: string): void => {
      ui.tab.handleInput("s");
      const popup = ui.popups.at(-1)!;
      assert.equal(popup.content.title, "sort");
      assert.match(stripTerminalSequences(popup.content.text), /n  newest activity first/);
      popup.keys?.[key]?.();
    };
    ui.tab.handleInput("j");
    pick("n");
    assert.deepEqual(order(ui.tab), [DELTA, ALPHA, CHARLIE, BRAVO, SECOND, FIRST]);
    assert.match(text(ui.tab), /sort: newest  item 4\/6/);
    assert.match(text(ui.tab), /^\s+b\.ts:9\s/m);
    pick("d");
    assert.deepEqual(order(ui.tab), [ALPHA, BRAVO, CHARLIE, DELTA, FIRST, SECOND]);
    pick("u");
    assert.deepEqual(order(ui.tab), [CHARLIE, BRAVO, DELTA, ALPHA, SECOND, FIRST]);
    pick("f");
    assert.deepEqual(order(ui.tab), [DELTA, CHARLIE, BRAVO, ALPHA, FIRST, SECOND]);
    ui.tab.handleInput("R");
    await tick();
    assert.match(text(ui.tab), /sort: file  item 3\/6/);
    assert.deepEqual(order(ui.tab), [DELTA, CHARLIE, BRAVO, ALPHA, FIRST, SECOND]);
    pick("d");
    assert.deepEqual(order(ui.tab), [ALPHA, BRAVO, CHARLIE, DELTA, FIRST, SECOND]);
  } finally {
    f.cleanup();
  }
});

test("sidebar entries are two rows: location or type, then state, author and comment count", () => {
  const f = gitFixture();
  try {
    const long = "This is a fairly long review comment that must not show up in the sidebar list";
    const path = "deeply/nested/directory/structure/for/the/module/file.ts";
    const reply = comment({ id: "c2", author: { login: "dave", type: "User", association: "MEMBER" }, body: "agreed" });
    const s = snapshot(f, [
      thread({ id: "L", path, line: 4 }, { body: long }),
      thread({ id: "R", path: "r.ts", line: 2, is_resolved: true, is_outdated: true, comments: [comment({ body: long }), reply] }),
    ], {
      conversation: [
        entry,
        { ...entry, id: "R10", state: "CHANGES_REQUESTED", body: long },
        { ...entry, id: "R11", state: "COMMENTED" },
        { ...entry, id: "C1", kind: "comment", state: null, author: { ...entry.author, login: "erin" }, is_minimized: true, minimized_reason: "OUTDATED" },
      ],
    });
    s.threads[1]!.comments_total = 3;
    const ui = setup(f, { load: () => s });
    const side = sideRows(ui.tab, 120).map((l) => l.trim());
    assert.ok(side.every((l) => !/fairly long|Looks good|agreed/.test(l)));
    const rowsOf = (label: RegExp): string[] => {
      const at = side.findIndex((l) => label.test(l));
      assert.ok(at >= 0, `missing ${label}`);
      return side.slice(at, at + 3);
    };
    const [loc, sub, next] = rowsOf(/module\/file\.ts:4/);
    assert.match(loc ?? "", /^▎?….*module\/file\.ts:4$/);
    assert.equal(sub, "▎alice · 1 comment");
    assert.equal(next, "r.ts:2");
    assert.deepEqual(rowsOf(/^r\.ts:2$/).slice(0, 2), ["r.ts:2", "resolved outdated  alice · 3 comments"]);
    assert.deepEqual(rowsOf(/^review approved$/), ["review approved", "carol · 1 comment", "review changes requested"]);
    assert.deepEqual(rowsOf(/^review changes requested$/).slice(0, 2), ["review changes requested", "carol · 1 comment"]);
    assert.deepEqual(rowsOf(/^review$/).slice(0, 2), ["review", "carol · 1 comment"]);
    assert.deepEqual(rowsOf(/^PR comment$/).slice(0, 2), ["PR comment", "hidden  erin · 1 comment"]);
  } finally {
    f.cleanup();
  }
});

test("the sidebar scrolls to keep tall entries fully visible", () => {
  const f = gitFixture();
  try {
    const threads = Array.from({ length: 20 }, (_, i) => thread({ id: `T${i}`, path: `f${i}.ts`, line: 1 }, { body: `comment ${i} `.repeat(30) }));
    const ui = setup(f, { load: () => snapshot(f, threads) });
    const sideOf = () => narrow(ui.tab).map((l) => l.slice(l.indexOf("│") + 1)).join("\n");
    for (let i = 0; i < 19; i++) ui.tab.handleInput("j");
    assert.match(sideOf(), /f19\.ts:1/);
    assert.match(sideOf(), /▎f19\.ts:1\s*\n▎alice · 1 comment/);
    assert.doesNotMatch(sideOf(), /f0\.ts:1/);
    ui.tab.handleInput("g");
    assert.match(sideOf(), /Code threads 20/);
    assert.match(sideOf(), /f0\.ts:1/);
  } finally {
    f.cleanup();
  }
});

test("ctrl+up/down and plain arrows move between sidebar entries", () => {
  const f = gitFixture();
  try {
    const ui = setup(f, { load: () => feedback(f) });
    ui.tab.handleInput(CTRL_DOWN);
    ui.tab.handleInput(CTRL_DOWN);
    assert.match(text(ui.tab), /item 3\/4/);
    ui.tab.handleInput(CTRL_UP);
    assert.match(text(ui.tab), /item 2\/4/);
    ui.tab.handleInput("\x1b[B");
    ui.tab.handleInput("\x1bOB");
    assert.match(text(ui.tab), /item 4\/4/);
    ui.tab.handleInput("\x1b[A");
    assert.match(text(ui.tab), /item 3\/4/);
  } finally {
    f.cleanup();
  }
});

test("t hides the sidebar for a full-width detail and survives refresh", async () => {
  const f = gitFixture();
  try {
    const s = feedback(f);
    const ui = setup(f, { load: () => s, fetch: async () => s });
    assert.match(text(ui.tab), /│/);
    assert.match(text(ui.tab), /t hide list/);
    ui.tab.handleInput("t");
    const out = text(ui.tab);
    assert.doesNotMatch(out, /│/);
    assert.doesNotMatch(out, /Code threads/);
    assert.match(out, /t show list/);
    assert.match(out, /why delete\?/);
    ui.tab.handleInput("j");
    assert.match(text(ui.tab), /item 2\/4/);
    ui.tab.handleInput("R");
    await tick();
    assert.doesNotMatch(text(ui.tab), /Code threads/);
    ui.tab.handleInput("t");
    assert.match(text(ui.tab), /Code threads 3/);
  } finally {
    f.cleanup();
  }
});

test("when renders timestamps in the process local timezone", () => {
  const saved = process.env.TZ;
  try {
    process.env.TZ = "Asia/Taipei";
    assert.equal(when("2025-01-02T20:30:00Z"), "2025-01-03 04:30");
    process.env.TZ = "UTC";
    assert.equal(when("2025-01-02T20:30:00Z"), "2025-01-02 20:30");
    assert.equal(when(null), "");
    assert.equal(when("not a date"), "not a date");
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});
