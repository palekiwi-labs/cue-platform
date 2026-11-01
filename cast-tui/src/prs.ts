import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Markdown } from "@earendil-works/pi-tui";
import { findCheckout } from "./checkouts.js";
import { copyToClipboard, type Exec, type ExecResult } from "./exec.js";
import type {
  CheckoutTarget,
  HostAction,
  Loaded,
  Outcome,
  PrDeps,
} from "./picker/prs/browser.js";
import {
  mergeSearches,
  type Pr,
  SEARCH_QUERY,
  searchString,
  type View,
  worktreeFor,
} from "./picker/prs/model.js";
import { fetchDetail, PreviewCache } from "./picker/prs/preview.js";
import { markdownTheme } from "./theme.js";

/** Root of the cue store: $CUE_STORE, else ~/cue. */
export function storeRoot(env: NodeJS.ProcessEnv, home: string): string {
  return env.CUE_STORE || join(home, "cue");
}

async function subdirs(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

/** Orgs with a directory in the cue store. */
export function storeOrgs(root: string): Promise<string[]> {
  return subdirs(root);
}

/** `<org>/<repo>` for each repo directory under the store's orgs. */
export async function storeRepos(
  root: string,
  orgs: string[],
): Promise<string[]> {
  const per = await Promise.all(
    orgs.map(async (org) =>
      (await subdirs(join(root, org))).map((repo) => `${org}/${repo}`),
    ),
  );
  return per.flat().sort();
}

async function search(
  exec: Exec,
  cwd: string,
  repos: string[],
): Promise<Loaded | { error: string }> {
  const results = await Promise.all(
    repos.map(async (repo) => ({
      repo,
      ...(await exec(
        "gh",
        [
          "api",
          "graphql",
          "-F",
          `q=${searchString(repo)}`,
          "-f",
          `query=${SEARCH_QUERY}`,
        ],
        { cwd },
      )),
    })),
  );
  return mergeSearches(results);
}

export function failed(what: string, r: ExecResult): Outcome {
  return {
    ok: false,
    text: `${what}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`,
  };
}

/**
 * Checks a PR out in the local clone of its repo: reuses a checkout
 * already on the branch, else `gh pr checkout` in a clean root or a new
 * `worktrees/<headRef>` worktree.
 */
export async function checkout(
  exec: Exec,
  root: string | undefined,
  pr: Pr,
  where: CheckoutTarget,
): Promise<Outcome> {
  if (!root) return { ok: false, text: `no local checkout of ${pr.repo}` };
  const list = await exec("git", ["worktree", "list", "--porcelain"], {
    cwd: root,
  });
  if (list.code !== 0) return failed("git worktree list", list);
  const existing = worktreeFor(list.stdout, pr.headRef);
  if (existing) {
    return {
      ok: true,
      text: `${pr.headRef} is already checked out in ${existing}`,
      path: existing,
    };
  }
  if (where === "root") {
    const st = await exec("git", ["status", "--porcelain"], { cwd: root });
    if (st.code !== 0) return failed("git status", st);
    if (st.stdout.trim()) {
      return {
        ok: false,
        text: `${root} has uncommitted changes; not checking out #${pr.number}`,
      };
    }
    const r = await exec("gh", ["pr", "checkout", String(pr.number)], {
      cwd: root,
    });
    return r.code === 0
      ? {
          ok: true,
          text: `checked out #${pr.number} (${pr.headRef}) in ${root}`,
          path: root,
        }
      : failed("gh pr checkout", r);
  }
  const fetch = await exec(
    "git",
    ["fetch", "origin", `pull/${pr.number}/head:${pr.headRef}`],
    { cwd: root },
  );
  if (fetch.code !== 0) return failed("git fetch", fetch);
  const path = join(root, "worktrees", pr.headRef);
  const add = await exec("git", ["worktree", "add", path, pr.headRef], {
    cwd: root,
  });
  return add.code === 0
    ? { ok: true, text: `worktree for #${pr.number} at ${path}`, path }
    : failed("git worktree add", add);
}

export interface HostOptions {
  exec: Exec;
  cwd: string;
  store: string;
  roots: string[];
  previews: PreviewCache;
  actions?: (pr: Pr) => HostAction[];
}

/** Picker dependencies for cast-tui: org view over the cue store's repos. */
export async function hostDeps(o: HostOptions): Promise<PrDeps> {
  const orgs = await storeOrgs(o.store);
  const load = async (view: View): Promise<Loaded | { error: string }> => {
    if (view === "repo") return { error: "cast-tui has no repo view" };
    if (orgs.length === 0) return { error: `no orgs in ${o.store}` };
    const repos = await storeRepos(o.store, orgs);
    if (repos.length === 0) return { error: `no repos in ${o.store}` };
    return search(o.exec, o.cwd, repos);
  };
  return {
    load,
    detail: (pr) => fetchDetail(o.exec, o.cwd, pr),
    previews: o.previews,
    localRepo: undefined,
    orgs,
    view: "org",
    checkout: (pr, where) =>
      checkout(o.exec, findCheckout(pr.repo, o.roots), pr, where),
    copy: copyToClipboard,
    markdown: (body, width) =>
      new Markdown(body, 0, 0, markdownTheme).render(width),
    ...(o.actions ? { actions: o.actions } : {}),
  };
}
