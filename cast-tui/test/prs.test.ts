import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../src/exec.js";
import type { Pr } from "../src/picker/prs/model.js";
import { PreviewCache } from "../src/picker/prs/preview.js";
import {
  checkout,
  hostDeps,
  storeOrgs,
  storeRepos,
  storeRoot,
} from "../src/prs.js";

function store(): string {
  const root = mkdtempSync(join(tmpdir(), "cast-tui-store-"));
  for (const dir of ["acme/api", "acme/web", "solo/tool", ".git"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, "acme", "notes.md"), "");
  return root;
}

const PR = { repo: "acme/api", number: 7, headRef: "fix-it" } as Pr;

test("store root is $CUE_STORE, else ~/cue", () => {
  assert.equal(storeRoot({ CUE_STORE: "/s" }, "/h"), "/s");
  assert.equal(storeRoot({}, "/h"), "/h/cue");
});

test("orgs and repos are the store's directories", async () => {
  const root = store();
  assert.deepEqual(await storeOrgs(root), ["acme", "solo"]);
  assert.deepEqual(await storeRepos(root, ["acme", "solo", "missing"]), [
    "acme/api",
    "acme/web",
    "solo/tool",
  ]);
});

test("org view searches every store repo with gh", async () => {
  const root = store();
  const searched: string[] = [];
  const exec: Exec = async (cmd, args) => {
    assert.equal(cmd, "gh");
    searched.push(args.find((a) => a.startsWith("q=")) ?? "");
    return { code: 1, stdout: "", stderr: "offline" };
  };
  const deps = await hostDeps({
    exec,
    cwd: "/",
    store: root,
    roots: [],
    previews: new PreviewCache(),
  });
  assert.equal(deps.view, "org");
  assert.deepEqual(deps.orgs, ["acme", "solo"]);
  assert.equal(deps.sessions, undefined);
  const loaded = await deps.load("org");
  assert.ok("error" in loaded && loaded.error.includes("offline"));
  assert.equal(searched.length, 3);
  assert.ok("error" in (await deps.load("repo")));
});

test("checkout needs a local clone", async () => {
  const exec: Exec = async () => assert.fail("no command expected");
  const o = await checkout(exec, undefined, PR, "worktree");
  assert.deepEqual(o, { ok: false, text: "no local checkout of acme/api" });
});

test("checkout reuses a worktree already on the branch", async () => {
  const exec: Exec = async () => ({
    code: 0,
    stdout: "worktree /c/api/worktrees/fix-it\nbranch refs/heads/fix-it\n",
    stderr: "",
  });
  const o = await checkout(exec, "/c/api", PR, "worktree");
  assert.equal(o.ok, true);
  assert.equal(o.path, "/c/api/worktrees/fix-it");
});

test("worktree checkout fetches the PR head and adds a worktree", async () => {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    calls.push(`${opts.cwd}: ${cmd} ${args.join(" ")}`);
    return { code: 0, stdout: "", stderr: "" };
  };
  const o = await checkout(exec, "/c/api", PR, "worktree");
  assert.equal(o.path, "/c/api/worktrees/fix-it");
  assert.deepEqual(calls, [
    "/c/api: git worktree list --porcelain",
    "/c/api: git fetch origin pull/7/head:fix-it",
    "/c/api: git worktree add /c/api/worktrees/fix-it fix-it",
  ]);
});
