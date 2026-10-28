import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import {
  type CheckoutTarget,
  type Loaded,
  type Outcome,
  PrBrowser,
  type PrDeps,
  type ReviewRequest,
} from "../prs/browser"
import {
  branchLinks,
  linkAddress,
  linkValue,
  latestSession,
  mergeSearches,
  type Pr,
  repoOfRemote,
  resolveScope,
  SEARCH_QUERY,
  searchString,
  type View,
  worktreeFor,
} from "../prs/model"
import { type ContextRow, parseContextTree, pinnedFirst } from "../browser/model"
import { loadSessions, newSession, resumeSession, saveRecencyDays, storeRoot, storedRecencyDays } from "./cue-browser"
import { scopeOfRemote } from "../browser/sessions"
import { currentContext } from "../lib/current-context"
import { defaultTarget } from "../lib/default-target"

/** Open the GitHub PR browser. */
export const PRS_SHORTCUT = "alt+p"

type Exec = ExtensionAPI["exec"]

async function lines(exec: Exec, cwd: string, cmd: string, args: string[]): Promise<string[]> {
  const r = await exec(cmd, args, { cwd })
  return r.code === 0 ? r.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : []
}

/** One GraphQL search per scope, in parallel; the first gh error wins. */
/** One search per repo, in parallel; see mergeSearches for failures. */
async function search(exec: Exec, cwd: string, repos: string[]): Promise<Loaded | { error: string }> {
  const results = await Promise.all(
    repos.map(async (repo) => ({
      repo,
      ...(await exec("gh", ["api", "graphql", "-F", `q=${searchString(repo)}`, "-f", `query=${SEARCH_QUERY}`], {
        cwd,
      })),
    })),
  )
  return mergeSearches(results)
}

/**
 * Org view repos: those of each org with a scope directory in the cue
 * store (`<store>/<org>/<repo>`), i.e. the repos the operator works on.
 */
async function storeRepos(cwd: string, orgs: string[]): Promise<string[]> {
  const root = storeRoot(cwd)
  const per = await Promise.all(
    orgs.map(async (org) => {
      const entries = await readdir(join(root, org), { withFileTypes: true }).catch(() => [])
      return entries.filter((e) => e.isDirectory()).map((e) => `${org}/${e.name}`)
    }),
  )
  return per.flat().sort()
}

async function loadView(exec: Exec, cwd: string, view: View, localRepo: string | undefined, orgs: string[]) {
  if (view === "repo") {
    if (!localRepo) return { error: "no GitHub repo (origin is not a GitHub remote)" }
    return search(exec, cwd, [localRepo])
  }
  if (orgs.length === 0) return { error: "no GitHub org (origin is not a GitHub remote and cue.gh-org is unset)" }
  const repos = await storeRepos(cwd, orgs)
  if (repos.length === 0) return { error: `no repos of ${orgs.join(", ")} in the cue store` }
  return search(exec, cwd, repos)
}

const failed = (what: string, r: { stdout: string; stderr: string; code: number }): Outcome => ({
  ok: false,
  text: `${what}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`,
})

/**
 * Reuse any checkout (root or worktree) already holding the branch. Else
 * root: `gh pr checkout`, refused on a dirty tree; worktree: fetch the PR head into a local branch and add
 * `worktrees/<headRef>` under the repo root.
 */
async function checkout(exec: Exec, cwd: string, pr: Pr, where: CheckoutTarget): Promise<Outcome> {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd })
  if (top.code !== 0) return failed("not a git checkout", top)
  const root = top.stdout.trim()
  const list = await exec("git", ["worktree", "list", "--porcelain"], { cwd: root })
  if (list.code !== 0) return failed("git worktree list", list)
  const existing = worktreeFor(list.stdout, pr.headRef)
  if (existing) return { ok: true, text: `${pr.headRef} is already checked out in ${existing}`, path: existing }
  if (where === "root") {
    const st = await exec("git", ["status", "--porcelain"], { cwd: root })
    if (st.code !== 0) return failed("git status", st)
    if (st.stdout.trim()) return { ok: false, text: `${root} has uncommitted changes; not checking out #${pr.number}` }
    const r = await exec("gh", ["pr", "checkout", String(pr.number)], { cwd: root })
    return r.code === 0 ? { ok: true, text: `checked out #${pr.number} (${pr.headRef}) in ${root}`, path: root } : failed("gh pr checkout", r)
  }
  const fetch = await exec("git", ["fetch", "origin", `pull/${pr.number}/head:${pr.headRef}`], { cwd: root })
  if (fetch.code !== 0) return failed("git fetch", fetch)
  const path = join(root, "worktrees", pr.headRef)
  const add = await exec("git", ["worktree", "add", path, pr.headRef], { cwd: root })
  return add.code === 0 ? { ok: true, text: `worktree for #${pr.number} at ${path}`, path } : failed("git worktree add", add)
}

async function manifests(exec: Exec, cwd: string): Promise<string[] | { error: string }> {
  const r = await exec("cue-review", ["manifests", "--json"], { cwd })
  if (r.code !== 0) return { error: (r.stderr || r.stdout).trim() || `exit ${r.code}` }
  try {
    const rows: unknown = JSON.parse(r.stdout)
    if (!Array.isArray(rows)) return { error: "expected a JSON array" }
    return rows.map((m) => m?.name).filter((n): n is string => typeof n === "string")
  } catch (e) {
    return { error: `bad JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * The context tree as the cue browser lists it (the configured scope,
 * cross-repo included), pinned first; empty when cue fails.
 */
async function contexts(exec: Exec, cwd: string): Promise<ContextRow[]> {
  const r = await exec("cue", ["context", "tree", "--sort", "recency", "--json"], { cwd })
  if (r.code !== 0) return []
  try {
    return pinnedFirst(parseContextTree(r.stdout))
  } catch {
    return []
  }
}

/** Detached run in the review tmux session; cue-review prints where it went. */
async function launchReview(exec: Exec, cwd: string, req: ReviewRequest): Promise<Outcome> {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd })
  if (top.code !== 0) return failed("not a git checkout", top)
  const args = ["pr", String(req.pr.number), "--manifest", req.manifest, "--context", req.context]
  if (req.parent) args.push("--parent", req.parent)
  args.push("-C", top.stdout.trim())
  const r = await exec("cue-review", args, { cwd })
  if (r.code !== 0) return failed("cue-review", r)
  const out = (r.stdout + r.stderr).trim().split("\n").filter(Boolean).pop() ?? ""
  return { ok: true, text: `review of #${req.pr.number} started (${req.context}, ${req.manifest})${out ? `: ${out}` : ""}` }
}

/** Branch -> linked context address; slugs resolve in the repo scope. */
async function links(exec: Exec, cwd: string, scope: string | undefined): Promise<Map<string, string>> {
  const r = await exec("git", ["config", "--local", "--get-regexp", "^branch\\..*\\.cue-context$"], { cwd })
  if (r.code !== 0) return new Map()
  const out = new Map<string, string>()
  for (const [branch, value] of branchLinks(r.stdout)) {
    const address = linkAddress(value, scope)
    if (address) out.set(branch, address)
  }
  return out
}

/**
 * Link a PR branch to a context, creating the context first when asked.
 * The operator triggers this from the browser, so writing the branch
 * association (operator state) is intended. The branch need not exist
 * locally yet: checkout creates it under the same name.
 */
async function link(
  exec: Exec,
  cwd: string,
  scope: string | undefined,
  branch: string,
  context: string,
  create?: { parent?: string },
): Promise<Outcome> {
  if (!scope) return { ok: false, text: "no cue scope (origin remote missing)" }
  if (create) {
    const args = ["context", "create", context]
    if (create.parent) args.push("--parent", create.parent)
    const r = await exec("cue", args, { cwd })
    if (r.code !== 0) return failed("cue context create", r)
  }
  const address = create ? `${scope}/${context}` : context
  // Same-scope links stay slugs, as `cue context switch` writes them; cue
  // also accepts a full address, which cross-scope contexts need.
  const value = linkValue(address, scope)
  const r = await exec("cue", ["context", "switch", value, "--branch", branch], { cwd })
  return r.code === 0
    ? { ok: true, text: `${create ? "created and linked" : "linked"} ${branch} to ${address}`, address }
    : failed("cue context switch", r)
}

async function openPrs(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return
  const exec: Exec = (cmd, args, opts) => pi.exec(cmd, args, opts)
  const cwd = ctx.cwd
  const [origin, ghOrgs] = await Promise.all([
    lines(exec, cwd, "git", ["remote", "get-url", "origin"]),
    lines(exec, cwd, "git", ["config", "--get-all", "cue.gh-org"]),
  ])
  const localRepo = origin[0] ? repoOfRemote(origin[0]) : undefined
  const { orgs, view } = resolveScope(ghOrgs, localRepo)
  const scope = origin[0] ? scopeOfRemote(origin[0]) : undefined
  const deps: PrDeps = {
    load: (v) => loadView(exec, cwd, v, localRepo, orgs),
    localRepo,
    orgs,
    view,
    checkout: (pr, where) => checkout(exec, cwd, pr, where),
    manifests: () => manifests(exec, cwd),
    contexts: () => contexts(exec, cwd),
    recencyDays: () => storedRecencyDays(cwd),
    saveRecencyDays: (d) => saveRecencyDays(cwd, d),
    launchReview: (req) => launchReview(exec, cwd, req),
    copy: copyToClipboard,
    scope,
    links: () => links(exec, cwd, scope),
    link: (branch, context, create) => link(exec, cwd, scope, branch, context, create),
    latestSession: async (address) => latestSession(await loadSessions(pi, cwd), address),
    resume: (session, target) => resumeSession(pi, ctx, session, target),
    currentSession: () => ctx.sessionManager.getSessionFile(),
    sessionContext: () => currentContext(ctx.sessionManager.getBranch()),
    startSession: (address, target, note) => newSession(pi, ctx, address, target, note),
    target: defaultTarget(ctx.sessionManager.getEntries()),
  }
  await ctx.ui.custom<void>(
    (tui, theme, kb, done) => new PrBrowser(tui, theme, kb, deps, () => done()),
    {
      overlay: true,
      overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
    },
  )
}

export function registerPrBrowser(pi: ExtensionAPI): void {
  pi.registerCommand("cue:prs", {
    description: "Browse open GitHub PRs of this repo or its orgs (full screen)",
    handler: async (_args, ctx) => openPrs(pi, ctx),
  })
  pi.registerShortcut(PRS_SHORTCUT, {
    description: "Browse open GitHub PRs (full screen)",
    handler: async (ctx) => openPrs(pi, ctx),
  })
}
