import assert from "node:assert/strict";
import { test } from "node:test";
import { type ActivityFilters, DETACHED, type GitEvent, groupActivity, parseEvent, repoLabel } from "../src/activity.js";

const all: ActivityFilters = { repo: null, hideCheckouts: false, hideTmp: false, agentsOnly: false };

let n = 0;
function ev(over: Partial<GitEvent>): GitEvent {
  n++;
  return {
    v: 1,
    id: `id-${n}`,
    hook: "post-commit",
    args: [],
    ts: `2026-11-18T10:00:${String(n).padStart(2, "0")}.000Z`,
    repo: { origin: "https://github.com/palekiwi-labs/cue-platform", common_dir: "/home/pl/code/cue-platform/.git" },
    branch: "dev",
    ...over,
  };
}

test("parseEvent accepts v1 payloads and rejects others", () => {
  const e = ev({});
  assert.deepEqual(parseEvent(JSON.stringify(e)), e);
  assert.equal(parseEvent("not json"), null);
  assert.equal(parseEvent(JSON.stringify({ ...e, v: 2 })), null);
  assert.equal(parseEvent(JSON.stringify({ ...e, repo: {} })), null);
  assert.equal(parseEvent(JSON.stringify({ t: 1 })), null);
});

test("repoLabel uses the origin slug, else the repo dir name", () => {
  assert.equal(repoLabel({ origin: "git@github.com:palekiwi/nix-config.git", common_dir: "/x/.git" }), "palekiwi/nix-config");
  assert.equal(repoLabel({ origin: "https://github.com/org/llm-agents.nix", common_dir: "/x/.git" }), "org/llm-agents.nix");
  assert.equal(repoLabel({ common_dir: "/tmp/t/.git" }), "t");
});

test("groupActivity groups by repo and branch, newest first, with counts", () => {
  const events = [
    ev({ hook: "post-commit" }),
    ev({ hook: "post-checkout", branch: "side" }),
    ev({ hook: "post-commit", branch: "side" }),
    ev({ hook: "post-rewrite", args: ["amend"], rewrites: [{ old: "a", new: "b" }] }),
    ev({ hook: "post-commit", branch: undefined }),
  ];
  const groups = groupActivity(events, all);
  assert.deepEqual(groups.map((g) => g.branch), [DETACHED, "dev", "side"]);
  const dev = groups[1]!;
  assert.equal(dev.repoLabel, "palekiwi-labs/cue-platform");
  assert.equal(dev.commits, 1);
  assert.equal(dev.rewrites, 1);
  assert.equal(dev.last.hook, "post-rewrite");
  assert.deepEqual(dev.events.map((e) => e.hook), ["post-rewrite", "post-commit"]);
});

test("filters apply scope, checkouts, tmp repos and agents", () => {
  const tmp = { common_dir: "/tmp/t/.git" };
  const events = [
    ev({ actor: { pi_session: "s1" } }),
    ev({ hook: "post-checkout", branch: "side" }),
    ev({ repo: tmp, branch: "master" }),
  ];
  const branches = (f: Partial<ActivityFilters>): string[] => groupActivity(events, { ...all, ...f }).map((g) => g.branch);
  assert.deepEqual(branches({ repo: "/tmp/t/.git" }), ["master"]);
  assert.deepEqual(branches({ hideCheckouts: true }), ["master", "dev"]);
  assert.deepEqual(branches({ hideTmp: true }), ["side", "dev"]);
  assert.deepEqual(branches({ agentsOnly: true }), ["dev"]);
});
