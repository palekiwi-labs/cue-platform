import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { listRuns, prContext } from "../src/pr-review.js";
import { runPickerText } from "../src/pr-tabs.js";
import { type TabScreen, TabsScreen } from "../src/tabs.js";
import { listWalkthroughs, loadWalkthrough, walkthroughPath } from "../src/walkthrough.js";
import { walkthroughPickerText } from "../src/pr-tabs.js";

class Fake implements TabScreen {
  inputs: string[] = [];
  constructor(readonly name: string) {}
  invalidate(): void {}
  handleInput(data: string): void {
    this.inputs.push(data);
  }
  render(): string[] {
    return [`${this.name} title`, `${this.name} footer`];
  }
}

test("number keys switch tabs and keep each screen", () => {
  let built = 0;
  const a = new Fake("a");
  const b = new Fake("b");
  const tabs = new TabsScreen([
    { label: "changes", screen: () => (built++, a) },
    { label: "findings", screen: () => (built++, b) },
  ]);
  tabs.handleInput("j");
  tabs.handleInput("2");
  tabs.handleInput("k");
  tabs.handleInput("1");
  tabs.handleInput("3");
  tabs.handleInput("x");
  assert.deepEqual(a.inputs, ["j", "3", "x"]);
  assert.deepEqual(b.inputs, ["k"]);
  assert.equal(tabs.index, 0);
  tabs.handleInput("2");
  tabs.render(80);
  assert.equal(built, 2);
});

test("footer carries the tab strip with the active tab marked", () => {
  const tabs = new TabsScreen([
    { label: "changes", screen: () => new Fake("a") },
    { label: "findings", screen: () => new Fake("b") },
  ]);
  tabs.handleInput("2");
  const lines = tabs.render(80).map((l) => stripTerminalSequences(l));
  assert.match(lines[1]!, /^ 1 changes 2 findings │b footer/);
  assert.equal(lines[0], "b title");
});

test("runs are listed from review-pr-N newest first", () => {
  const store = mkdtempSync(join(tmpdir(), "station-runs-"));
  const runs = join(store, "org/repo/review-pr-7/review/runs");
  for (const id of ["100-a", "200-b", "300-c"]) mkdirSync(join(runs, id), { recursive: true });
  writeFileSync(join(runs, "100-a/run.json"), JSON.stringify({ head: "1".repeat(40), state: "completed" }));
  writeFileSync(join(runs, "100-a/verifiers-opus.json"), "{}");
  writeFileSync(join(runs, "200-b/run.json"), JSON.stringify({ head: "2".repeat(40), state: "running" }));
  assert.equal(prContext("org/repo", 7), "org/repo/review-pr-7");
  const list = listRuns("org/repo", 7, store);
  assert.deepEqual(list.map((r) => [r.runId, r.verified, r.state]), [["200-b", false, "running"], ["100-a", true, "completed"]]);
  assert.equal(list[0]!.address, "org/repo/review-pr-7/review/runs/200-b");
  assert.deepEqual(listRuns("org/repo", 8, store), []);
  assert.match(runPickerText(list), /^a  200-b  head 2222222222  running\nb  100-a  head 1111111111  verified$/);
});

test("walkthrough addresses, listing and file shape", () => {
  const store = mkdtempSync(join(tmpdir(), "station-walk-"));
  const address = "org/repo/review-pr-7/review/walkthrough/w1.json";
  assert.throws(() => walkthroughPath("org/repo/ctx/review/w1.json", store));
  assert.throws(() => walkthroughPath("org/repo/ctx/review/walkthrough/../x.json", store));
  const dir = join(store, "org/repo/review-pr-7/review/walkthrough");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(store, address), JSON.stringify({
    version: 1,
    pr: 7,
    base: "b",
    head: "h".repeat(12),
    title: "t",
    summary: "s",
    chunks: [
      {
        id: "c1",
        title: "first",
        sections: [
          { title: "a", markdown: "x", file: { path: "f.ts", lines: [9, 3] } },
          { markdown: "y", file: { path: "g.ts" } },
          { title: "c", markdown: "z", file: { lines: [1, 2] } },
        ],
      },
      {},
    ],
  }));
  writeFileSync(join(dir, "w0.json"), JSON.stringify({ version: 1, title: "older", head: "0".repeat(12) }));
  writeFileSync(join(dir, "broken.json"), "{");
  const w = loadWalkthrough(address, store);
  assert.equal(w.pr, 7);
  assert.equal(w.summary, "s");
  assert.deepEqual(w.chunks[0]!.sections, [
    { title: "a", markdown: "x", file: { path: "f.ts", lines: [3, 9] } },
    { title: "Section 2", markdown: "y", file: { path: "g.ts", lines: null } },
    { title: "c", markdown: "z", file: null },
  ]);
  assert.deepEqual(w.chunks[1], { id: "chunk-2", title: "Chunk 2", summary: "", sections: [] });
  const list = listWalkthroughs("org/repo", 7, store);
  assert.deepEqual(list.map((e) => e.id), ["w1", "w0"]);
  assert.equal(walkthroughPickerText(list), "a  w1  head hhhhhhhhhh  t\nb  w0  head 0000000000  older");
  writeFileSync(join(dir, "v2.json"), JSON.stringify({ version: 2 }));
  assert.throws(() => loadWalkthrough("org/repo/review-pr-7/review/walkthrough/v2.json", store), /version 2/);
});
