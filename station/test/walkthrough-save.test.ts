import assert from "node:assert/strict";
import { test } from "node:test";
import { preparerRun, saveCommand } from "../src/prepare.js";
import type { ResolvedPr } from "../src/source.js";
import { checkWalkthroughV2 } from "../src/walkthrough.js";
import { checkRefs } from "../src/walkthrough-save.js";

const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const OTHER = "c".repeat(40);
const pinned = { pr: 7, base: BASE, head: HEAD };

function walk(overrides: Record<string, unknown>, steps: unknown[]) {
  const data = {
    version: 2,
    pr: 7,
    base: BASE,
    head: HEAD,
    title: "T",
    chunks: [{ title: "C", sections: [{ title: "S", steps }] }],
    ...overrides,
  };
  const { walkthrough, errors } = checkWalkthroughV2("", data);
  assert.deepEqual(errors, []);
  return walkthrough;
}

const blobs = new Map<string, string | null>([
  [`${HEAD}:a.ts`, "1\n2\n3\n"],
  [`${BASE}:a.ts`, "1\n2"],
  [`${HEAD}:gone.ts`, null],
]);
const commits = (sha: string): boolean => sha === BASE || sha === HEAD;

test("checkRefs accepts refs inside their blobs", () => {
  const w = walk({}, [
    { code: { path: "a.ts", lines: [1, 3] } },
    { code: { path: "a.ts", lines: [2, 2], rev: "base" } },
    { markdown: "prose only" },
  ]);
  assert.deepEqual(checkRefs(w, pinned, commits, blobs), []);
});

test("checkRefs reports every problem with its path", () => {
  const w = walk({ pr: 8, head: OTHER }, [
    { code: { path: "a.ts", lines: [2, 4] } },
    { code: { path: "a.ts", lines: [1, 3], rev: "base" } },
    { code: { path: "gone.ts", lines: [1, 1], rev: HEAD } },
  ]);
  assert.deepEqual(checkRefs(w, pinned, commits, blobs), [
    "$.pr: must be 7",
    `$.head: must be the pinned head ${HEAD}`,
    `$.chunks[0].sections[0].steps[0].code.rev: commit ${OTHER} is not in the repository`,
    `$.chunks[0].sections[0].steps[1].code.lines: [1, 3] is past the end of a.ts (2 lines) at ${BASE}`,
    `$.chunks[0].sections[0].steps[2].code.path: no file gone.ts at ${HEAD}`,
  ]);
});

const pr: ResolvedPr = {
  repo: "/code/my repo",
  slug: "org/repo",
  number: 7,
  title: "Fix it",
  baseRefName: "master",
  headRefName: "fix",
  baseSha: BASE,
  headSha: HEAD,
};

test("preparerRun pins the head worktree and the review-pr context", () => {
  const run = preparerRun(["/nix/node", "/st/bin/station.js"], pr);
  assert.equal(run.cwd, "/code/my repo");
  assert.equal(run.context, "review-pr-7");
  assert.deepEqual(run.worktree, { base: HEAD });
  assert.equal(run.model, "anthropic/claude-opus-5-5");
  assert.equal(run.agent.isolated, true);
  assert.ok(run.prompt.includes(saveCommand(["/nix/node", "/st/bin/station.js"], pr)));
  assert.deepEqual(run.agent.extensions, ["npm:@gotgenes/pi-anthropic-auth"]);
  const other = preparerRun(["s"], pr, "m/x");
  assert.equal(other.model, "m/x");
  assert.equal(other.agent.extensions, undefined);
});

test("saveCommand quotes paths with spaces", () => {
  assert.equal(
    saveCommand(["/nix/node", "/st/bin/station.js"], pr),
    `/nix/node /st/bin/station.js walkthrough-save --repo '/code/my repo' --pr 7 --base ${BASE} --head ${HEAD} /tmp/walkthrough-pr-7.json`,
  );
});
