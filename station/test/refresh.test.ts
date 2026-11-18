import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { findingsTab, walkthroughTab, type PrTabHost } from "../src/pr-tabs.js";
import type { TabScreen } from "../src/tabs.js";
import { WalkthroughDrafts } from "../src/walkthrough-comments.js";
import { emptyWalkthroughComments } from "../src/state.js";
import { Drafts } from "../src/drafts.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "station-refresh-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  writeFileSync(join(repo, "a.ts"), Array.from({ length: 30 }, (_, i) => `const refreshedSource${i} = ${i};`).join("\n"));
  git("add", ".");
  git("commit", "-m", "fixture");
  const head = git("rev-parse", "HEAD");
  const store = join(root, "store");
  const before = process.env.CUE_STORE;
  process.env.CUE_STORE = store;
  const errors: string[] = [];
  const opened: string[] = [];
  const host: PrTabHost = {
    repo, repoSlug: "org/repo", pr: 7, prHead: head, prWorktree: repo,
    chosen: new Map(), onQuit: () => {},
    openPath: (_cwd, file, line) => opened.push(`${file}:${line}`),
    showPopup: (content) => { if (content.error) errors.push(content.text); },
  };
  const write = (address: string, data: unknown) => {
    const path = join(store, address);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(data));
  };
  const cleanup = () => {
    if (before === undefined) delete process.env.CUE_STORE;
    else process.env.CUE_STORE = before;
    rmSync(root, { recursive: true, force: true });
  };
  return { host, head, git, write, errors, opened, cleanup };
}

function text(tab: TabScreen): string {
  return tab.render(240).map(stripTerminalSequences).join("\n");
}

test("R retries absent and unfinished runs, preserves finding identity, clamps and retains data on failure", () => {
  const f = fixture();
  try {
    const tab = findingsTab(f.host);
    assert.match(text(tab), /R refresh/);
    const address = "org/repo/review-pr-7/review/runs/100-run";
    const run = { head: f.head, base: f.head, state: "running" };
    f.write(`${address}/run.json`, run);
    tab.handleInput("R");
    assert.match(text(tab), /no verified findings yet/);
    assert.equal(f.errors.length, 1);
    const finding = (id: string, line: number) => ({ id, severity: "low", title: id, file: "a.ts", line_start: line });
    const verify = (findings: unknown[]) => f.write(`${address}/verifiers-test.json`, { findings });
    verify([finding("a", 1), finding("b", 2), finding("c", 3)]);
    f.write(`${address}/run.json`, { ...run, state: "completed" });
    tab.handleInput("R");
    tab.handleInput("j");
    verify([finding("c", 3), finding("a", 1), finding("b", 20)]);
    tab.handleInput("R");
    tab.handleInput("e");
    assert.equal(f.opened.at(-1), "a.ts:20");
    assert.match(text(tab), /refreshedSource/);
    verify([finding("a", 10)]);
    tab.handleInput("R");
    tab.handleInput("e");
    assert.equal(f.opened.at(-1), "a.ts:10");
    f.write(`${address}/run.json`, { head: "missing" });
    tab.handleInput("R");
    tab.handleInput("e");
    assert.equal(f.opened.at(-1), "a.ts:10");
    assert.equal(f.errors.length, 2);
    writeFileSync(join(f.host.repo, "a.ts"), "const newSourceAfterRefresh = 2;\n");
    f.git("add", ".");
    f.git("commit", "-m", "update source");
    const head = f.git("rev-parse", "HEAD");
    f.host.prHead = head;
    f.write(`${address}/run.json`, { ...run, head });
    verify([finding("a", 1)]);
    tab.handleInput("R");
    assert.match(text(tab), /newSourceAfterRefresh/);
    assert.doesNotMatch(text(tab), /refreshedSource/);
    verify([]);
    f.write(`${address}/run.json`, run);
    tab.handleInput("R");
    assert.match(text(tab), /Findings 0/);
  } finally {
    f.cleanup();
  }
});

test("R reloads walkthrough sources and positions and re-evaluates address-bound drafts", () => {
  const f = fixture();
  try {
    const address = "org/repo/review-pr-7/review/walkthrough/w.json";
    const drafts = new WalkthroughDrafts(emptyWalkthroughComments(), () => {}, () => null, (_req, done) => done("draft"));
    const hub = new Drafts((_comments, done) => done(true));
    hub.register("walkthrough", drafts);
    f.host.walkthroughDrafts = drafts;
    f.host.drafts = hub;
    const tab = walkthroughTab(f.host);
    const section = (markdown: string, line: number) => ({ markdown, code: { path: "a.ts", lines: [line, line] } });
    const write = (steps: unknown[], extra = false) => f.write(address, {
      version: 2, head: f.head, base: f.head, title: "Reloaded walkthrough",
      chunks: [
        ...(extra ? [{ id: "before", title: "Before", sections: [{ title: "Before", steps: [{ markdown: "Before" }] }] }] : []),
        { id: "stable", title: "Stable", sections: [{ title: "Section", steps }] },
      ],
    });
    f.write(address, { version: 99, head: f.head });
    tab.handleInput("R");
    assert.equal(f.errors.length, 1);
    f.errors.length = 0;
    write([section("First", 1), section("Second", 2)]);
    tab.handleInput("R");
    tab.handleInput("\x1b[1;5B");
    tab.handleInput("\x1b[1;5B");
    tab.handleInput("\x1b[B");
    tab.handleInput("e");
    assert.equal(f.opened.at(-1), "a.ts:2");
    drafts.write({ chunk: 0, section: 0, step: 1 });
    assert.equal(hub.entries()[0]?.outdated, false);
    write([section("First new", 1), section("Second changed", 3)], true);
    tab.handleInput("R");
    tab.handleInput("e");
    assert.deepEqual(f.errors, []);
    assert.equal(f.opened.at(-1), "a.ts:3");
    assert.match(text(tab), /refreshedSource/);
    assert.match(text(tab), /R refresh/);
    assert.equal(hub.entries()[0]?.outdated, true);
    assert.equal(drafts.round()[0]?.comment.outdated, true);
    write([section("Only step", 1)], true);
    tab.handleInput("R");
    tab.handleInput("e");
    assert.equal(f.opened.at(-1), "a.ts:1");
    f.write(address, { version: 99 });
    tab.handleInput("R");
    assert.match(text(tab), /Only step/);
    assert.equal(f.errors.length, 1);
    f.write(address, { version: 1, head: f.head, base: f.head, title: "Empty", chunks: [] });
    tab.handleInput("R");
    assert.match(text(tab), /Empty/);
  } finally {
    f.cleanup();
  }
});
