import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { FeedbackTab, type FeedbackTabDeps } from "../src/feedback-view.js";
import type { ConversationEntry, FeedbackSnapshot } from "../src/github-feedback.js";
import type { PopupContent } from "../src/popup.js";
import type { PrTabHost } from "../src/pr-tabs.js";
import { gitFixture, type GitFixture, LEFT_HUNK, RIGHT_HUNK, snapshot, thread } from "./feedback-fixture.js";

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
    assert.match(text(ui.tab), /station github-feedback 7 --save/);
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
    assert.match(out, /resolved by bob/);
    assert.match(out, /Captured diff/);
    assert.match(out, /\+changed5/);
    assert.match(out, /rename this/);
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
    assert.deepEqual(ui.opened, [`pr|a.ts:7|${f.base}`]);

    ui.tab.handleInput("j");
    ui.tab.handleInput("e");
    await tick();
    assert.match(ui.popups.at(-1)?.content.text ?? "", /cannot open a\.ts:8: the thread has no comments/);
    assert.match(ui.popups.at(-1)?.content.text ?? "", /captured diff stays/);

    ui.tab.handleInput("j");
    ui.tab.handleInput("e");
    await until(() => ui.opened.length === 2);
    const worktree = join(f.repo, "worktrees", "review", "pr-7-findings");
    assert.equal(ui.opened.at(-1), `${worktree}|a.ts:8|-`);
    assert.equal(f.git("-C", worktree, "rev-parse", "HEAD"), f.base);

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
