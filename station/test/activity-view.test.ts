import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitEvent } from "../src/activity.js";
import { ActivityView, eventRows, eventSha } from "../src/activity-view.js";

const HERE = "/home/pl/code/cue-platform/.git";
const OTHER = "/home/pl/nix-config/.git";

let n = 0;
function ev(over: Partial<GitEvent>): GitEvent {
  n++;
  return {
    v: 1,
    id: `id-${n}`,
    hook: "post-commit",
    args: [],
    ts: `2026-11-18T10:00:${String(n).padStart(2, "0")}.000Z`,
    repo: { common_dir: HERE },
    branch: "dev",
    commit: { sha: `${String(n).padStart(4, "0")}abcdef0123`, parents: [], subject: `commit ${n}` },
    ...over,
  };
}

function view(copied: string[] = []): ActivityView {
  return new ActivityView({ repoDir: HERE, repoName: "cue-platform", allRepos: false, onQuit: () => {}, onCopy: (t) => copied.push(t) });
}

test("scope defaults to the current repo and a toggles all repos", () => {
  const v = view();
  v.add(ev({}));
  v.add(ev({ repo: { common_dir: OTHER } }));
  assert.deepEqual(v.rows().map((g) => g.repoDir), [HERE]);
  v.handleInput("a");
  assert.deepEqual(v.rows().map((g) => g.repoDir), [OTHER, HERE]);
});

test("checkouts are hidden by default and f cycles filters", () => {
  const v = view();
  v.add(ev({ hook: "post-checkout", branch: "side", commit: undefined }));
  assert.equal(v.rows().length, 0);
  v.handleInput("f");
  v.handleInput("f");
  assert.deepEqual(v.rows().map((g) => g.branch), ["side"]);
});

test("duplicate event ids are ignored", () => {
  const v = view();
  const e = ev({});
  v.add(e);
  v.add(e);
  assert.equal(v.rows()[0]?.events.length, 1);
});

test("y copies the latest sha, or the focused event in the timeline", () => {
  const copied: string[] = [];
  const v = view(copied);
  const older = ev({});
  const newer = ev({});
  v.add(older);
  v.add(newer);
  v.handleInput("y");
  v.handleInput("\t");
  v.handleInput("j");
  v.handleInput("y");
  assert.deepEqual(copied, [eventSha(newer), eventSha(older)]);
});

test("selection follows the branch when new events reorder rows", () => {
  const v = view();
  v.add(ev({ branch: "a" }));
  v.add(ev({ branch: "b" }));
  v.handleInput("j");
  assert.equal(v.selected()?.branch, "a");
  v.add(ev({ branch: "c" }));
  assert.equal(v.selected()?.branch, "a");
});

test("eventRows shows subject, actor and rewrite maps", () => {
  const rows = eventRows(ev({
    hook: "post-rewrite",
    args: ["rebase"],
    actor: { pi_session: "s", pi_model: "opus", cue_context: "review-station" },
    rewrites: [{ old: "aaaaaaaaaaaa", new: "bbbbbbbbbbbb" }],
  }), 200).join("\n");
  assert.match(rows, /rebase/);
  assert.match(rows, /commit \d+/);
  assert.match(rows, /opus {2}review-station/);
  assert.match(rows, /aaaaaaaaaa → bbbbbbbbbb/);
});

test("render fits the width", () => {
  const v = view();
  v.add(ev({}));
  for (const line of v.render(100)) assert.ok(line.length > 0);
});
