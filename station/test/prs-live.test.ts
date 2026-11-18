import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { ChangedEvent, RefreshOutcome } from "../../github-service/src/protocol.js";
import { LivePrs, type PrsFeed } from "../src/prs-live.js";
import type { PrsData } from "../src/prs-source.js";
import { PrsView } from "../src/prs.js";
import type { PrSummary } from "../src/source.js";

const hoursAgo = (h: number): string => new Date(Date.now() - h * 3600_000).toISOString();

const pr = (n: number, updated = n): PrSummary => ({
  number: n, title: `title ${n}`, url: `https://github.com/o/r/pull/${n}`, author: "alice", baseRef: "main",
  headRef: `b${n}`, defaultBranch: "main", isDraft: false, createdAt: hoursAgo(100 + n), updatedAt: hoursAgo(updated),
  reviewDecision: "", requested: [],
});

const data = (revision: number, prs: PrSummary[], over: Partial<PrsData> = {}): PrsData => ({
  prs, viewer: "me", storeId: "store", revision, note: `fetched r${revision}`, healthy: true, ...over,
});

const tick = () => new Promise((r) => setImmediate(r));

function setup(initial: PrsData) {
  let current = initial;
  let gate: Promise<void> | null = null;
  const calls = { read: 0, refresh: 0 };
  const changed = new Set<(event: ChangedEvent) => void>();
  const reconnect = new Set<() => void>();
  let refresh: () => Promise<RefreshOutcome | undefined> = async () => ({ state: "success", revision: current.revision, changed: false });
  const feed: PrsFeed = {
    repo: "o/r",
    read: async () => {
      calls.read++;
      const snapshot = current;
      if (gate !== null) await gate;
      return snapshot;
    },
    refresh: () => {
      calls.refresh++;
      return refresh();
    },
    onChanged: (l) => {
      changed.add(l);
      return () => changed.delete(l);
    },
    onReconnect: (l) => {
      reconnect.add(l);
      return () => reconnect.delete(l);
    },
  };
  const view = new PrsView({
    repo: "o/r", onQuit: () => {}, onOpen: () => {}, onCheckout: () => {}, onLaunch: () => {},
    onRefresh: () => void live.refresh(), onCopy: () => {}, onPickSort: () => {},
  });
  let renders = 0;
  const live = new LivePrs(view, feed, () => renders++);
  return {
    view, live, calls, changed, reconnect,
    set: (next: PrsData) => (current = next),
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
    onRefresh: (fn: () => Promise<RefreshOutcome | undefined>) => (refresh = fn),
    emit: (event: Partial<ChangedEvent>) => {
      for (const l of changed) l({ storeId: "store", repo: "o/r", revision: 2, ...event });
    },
    renders: () => renders,
  };
}

function screen(view: PrsView): string {
  return view.render(160).map(stripTerminalSequences).join("\n");
}

function body(view: PrsView): string[] {
  return view.render(160).map(stripTerminalSequences).slice(2, -1).filter((l) => l.trim() !== "");
}

test("a change event reloads the stored list keeping selection, sort, tree and scroll", async () => {
  const ui = setup(data(1, [pr(1), pr(2), pr(3), pr(4)]));
  await ui.live.start();
  assert.equal(ui.calls.read, 1);
  ui.view.setSort("created");
  ui.view.setLayout("tree");
  ui.view.handleInput("j");
  ui.view.handleInput("j");
  const selected = ui.view.selected()?.number;
  const row = body(ui.view).findIndex((l) => l.includes(`#${selected} `));
  ui.set(data(2, [{ ...pr(9), createdAt: hoursAgo(1) }, pr(1), pr(2), pr(3), pr(4)]));
  ui.emit({ repo: "o/other", revision: 2 });
  ui.emit({ revision: 1 });
  await tick();
  assert.equal(ui.calls.read, 1);
  const before = ui.renders();
  ui.emit({ revision: 2 });
  await tick();
  assert.equal(ui.calls.read, 2);
  assert.ok(ui.renders() > before);
  assert.equal(ui.view.selected()?.number, selected);
  assert.equal(ui.view.sortBy(), "created");
  assert.equal(ui.view.layoutMode(), "tree");
  assert.equal(body(ui.view).findIndex((l) => l.includes(`#${selected} `)), row + 1);
  assert.match(screen(ui.view), /PR list updated/);
  assert.match(screen(ui.view), /5 open/);
  assert.match(screen(ui.view), /fetched r2/);
  assert.doesNotMatch(screen(ui.view), /new PR data|r refresh/);
  ui.view.handleInput("j");
  assert.doesNotMatch(screen(ui.view), /PR list updated/);
  ui.live.dispose();
  assert.equal(ui.changed.size, 0);
  assert.equal(ui.reconnect.size, 0);
});

test("a selected PR that leaves the list selects its nearest neighbour with a note", async () => {
  const ui = setup(data(1, [pr(1), pr(2), pr(3), pr(4)]));
  await ui.live.start();
  ui.view.handleInput("j");
  ui.view.handleInput("j");
  assert.equal(ui.view.selected()?.number, 3);
  ui.set(data(2, [pr(1), pr(2), pr(4, 0)]));
  ui.emit({ revision: 2 });
  await tick();
  assert.equal(ui.view.selected()?.number, 4);
  assert.match(screen(ui.view), /PR #3 closed or merged/);
  ui.set(data(3, [pr(1), pr(2)]));
  ui.emit({ revision: 3 });
  await tick();
  assert.equal(ui.view.selected()?.number, 1);
  assert.match(screen(ui.view), /PR #4 closed or merged/);
});

test("a store reset reloads even at a lower revision", async () => {
  const ui = setup(data(5, [pr(1)]));
  await ui.live.start();
  ui.set(data(1, [pr(1), pr(2)], { storeId: "reset" }));
  ui.emit({ storeId: "reset", revision: 1 });
  await tick();
  assert.equal(ui.calls.read, 2);
  assert.match(screen(ui.view), /2 open/);
});

test("events during a reload coalesce and stale responses are ignored", async () => {
  const ui = setup(data(1, [pr(1)]));
  await ui.live.start();
  const release = ui.hold();
  ui.set(data(2, [pr(1), pr(2)]));
  ui.emit({ revision: 2 });
  ui.set(data(3, [pr(1), pr(2), pr(3)]));
  ui.emit({ revision: 3 });
  ui.emit({ revision: 3 });
  release();
  await tick();
  await tick();
  assert.equal(ui.calls.read, 3);
  assert.match(screen(ui.view), /3 open/);
  ui.set(data(2, [pr(1)]));
  ui.reconnect.forEach((l) => l());
  await tick();
  assert.equal(ui.calls.read, 4);
  assert.match(screen(ui.view), /3 open/);
});

test("a reconnect reloads only when the stored revision differs from the shown one", async () => {
  const ui = setup(data(1, [pr(1)]));
  await ui.live.start();
  ui.reconnect.forEach((l) => l());
  await tick();
  assert.equal(ui.calls.read, 2);
  assert.doesNotMatch(screen(ui.view), /PR list updated/);
  ui.set(data(2, [pr(1), pr(2)]));
  ui.reconnect.forEach((l) => l());
  await tick();
  assert.equal(ui.calls.read, 3);
  assert.match(screen(ui.view), /2 open/);
  assert.match(screen(ui.view), /PR list updated/);
});

test("R and r refresh through the service and the hints show R", async () => {
  const ui = setup(data(1, [pr(1)]));
  await ui.live.start();
  assert.match(screen(ui.view), /R refresh/);
  assert.doesNotMatch(screen(ui.view), / r refresh/);
  ui.set(data(1, [pr(1)], { note: "fetched later" }));
  ui.view.handleInput("R");
  await tick();
  assert.equal(ui.calls.refresh, 1);
  assert.equal(ui.calls.read, 2);
  assert.match(screen(ui.view), /fetched later/);
  ui.view.handleInput("r");
  await tick();
  assert.equal(ui.calls.refresh, 2);
  assert.equal(ui.calls.read, 3);
});

test("a refresh whose change event was applied reloads once", async () => {
  const ui = setup(data(1, [pr(1)]));
  await ui.live.start();
  let finish!: (outcome: RefreshOutcome) => void;
  ui.onRefresh(() => new Promise((r) => (finish = r)));
  ui.view.handleInput("R");
  assert.match(screen(ui.view), /refreshing through GitHub service/);
  ui.set(data(2, [pr(1), pr(2)]));
  ui.emit({ revision: 2 });
  await tick();
  assert.equal(ui.calls.read, 2);
  finish({ state: "success", revision: 2, changed: true });
  await tick();
  assert.equal(ui.calls.read, 2);
  assert.match(screen(ui.view), /fetched r2/);
  assert.doesNotMatch(screen(ui.view), /refreshing/);
});

test("a refresh whose change event is late or lost reloads once", async () => {
  const ui = setup(data(1, [pr(1)]));
  await ui.live.start();
  ui.onRefresh(async () => {
    ui.set(data(2, [pr(1), pr(2)]));
    return { state: "success", revision: 2, changed: true };
  });
  ui.view.handleInput("R");
  await tick();
  await tick();
  assert.equal(ui.calls.read, 2);
  ui.emit({ revision: 2 });
  await tick();
  assert.equal(ui.calls.read, 2);
  assert.match(screen(ui.view), /2 open/);
});

test("refresh and read failures are shown without dropping the list", async () => {
  const ui = setup(data(1, [pr(1)]));
  await ui.live.start();
  ui.onRefresh(async () => {
    throw new Error("GitHub service did not respond");
  });
  ui.view.handleInput("R");
  await tick();
  assert.match(screen(ui.view), /GitHub service: GitHub service did not respond/);
  assert.equal(ui.calls.read, 1);
  assert.match(screen(ui.view), /1 open/);
});

test("an update keeps the scroll position of a long list", async () => {
  const rows = process.stdout.rows;
  process.stdout.rows = 8;
  try {
    const many = Array.from({ length: 30 }, (_, i) => pr(i + 1));
    const ui = setup(data(1, many));
    await ui.live.start();
    for (let i = 0; i < 19; i++) ui.view.handleInput("j");
    const before = body(ui.view);
    ui.set(data(2, [...many, pr(40)]));
    ui.emit({ revision: 2 });
    await tick();
    assert.equal(ui.view.selected()?.number, 20);
    assert.deepEqual(body(ui.view), before);
  } finally {
    process.stdout.rows = rows;
  }
});
