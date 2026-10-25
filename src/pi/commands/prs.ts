import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent"
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
  PAGE,
  parseSearch,
  type Pr,
  repoOfRemote,
  resolveScope,
  SEARCH_QUERY,
  searchString,
  type View,
  worktreeFor,
} from "../prs/model"
import { type ContextRow, parseContextTree, pinnedFirst } from "../browser/model"
import { newSession, saveRecencyDays, storedRecencyDays } from "./cue-browser"
import { scopeOfRemote } from "../browser/sessions"
import { defaultTarget } from "../lib/default-target"

/** Open the GitHub PR browser. */
export const PRS_SHORTCUT = "alt+p"

type Exec = ExtensionAPI["exec"]

async function lines(exec: Exec, cwd: string, cmd: string, args: string[]): Promise<string[]> {
  const r = await exec(cmd, args, { cwd })
  return r.code === 0 ? r.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : []
}

/** One GraphQL search per scope, in parallel; the first gh error wins. */
async function search(exec: Exec, cwd: string, view: View, scopes: string[]): Promise<Loaded | { error: string }> {
  if (scopes.length === 0) return { error: "no GitHub scope (origin is not a GitHub remote and cue.gh-org is unset)" }
  const results = await Promise.all(
    scopes.map((s) =>
      exec("gh", ["api", "graphql", "-F", `q=${searchString(view, s)}`, "-f", `query=${SEARCH_QUERY}`], { cwd }),
    ),
  )
  const loaded: Loaded = { prs: [], viewer: "", truncated: false }
  for (const r of results) {
    if (r.code !== 0) return { error: (r.stderr || r.stdout).trim() || `gh exited ${r.code}` }
    try {
      const s = parseSearch(r.stdout)
      loaded.prs.push(...s.prs)
      loaded.viewer ||= s.viewer
      loaded.truncated ||= s.total > PAGE
    } catch (e) {
      return { error: `bad gh output: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  return loaded
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

/** The session repo's context tree, pinned first; empty when cue fails. */
async function contexts(exec: Exec, cwd: string): Promise<ContextRow[]> {
  const r = await exec("cue", ["context", "tree", "--scope", "repo", "--sort", "recency", "--json"], { cwd })
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

/** Branch -> context slug links of the repo. */
async function links(exec: Exec, cwd: string): Promise<Map<string, string>> {
  const r = await exec("git", ["config", "--local", "--get-regexp", "^branch\\..*\\.cue-context$"], { cwd })
  return r.code === 0 ? branchLinks(r.stdout) : new Map()
}

/**
 * Link a PR branch to a context, creating the context first when asked.
 * The operator triggers this from the browser, so writing the branch
 * association (operator state) is intended. The branch need not exist
 * locally yet: checkout creates it under the same name.
 */
async function link(exec: Exec, cwd: string, branch: string, slug: string, create?: { parent?: string }): Promise<Outcome> {
  if (create) {
    const args = ["context", "create", slug]
    if (create.parent) args.push("--parent", create.parent)
    const r = await exec("cue", args, { cwd })
    if (r.code !== 0) return failed("cue context create", r)
  }
  const r = await exec("cue", ["context", "switch", slug, "--branch", branch], { cwd })
  return r.code === 0 ? { ok: true, text: `linked ${branch} to ${slug}` } : failed("cue context switch", r)
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
  const deps: PrDeps = {
    load: (v) => search(exec, cwd, v, v === "repo" ? (localRepo ? [localRepo] : []) : orgs),
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
    links: () => links(exec, cwd),
    link: (branch, slug, create) => link(exec, cwd, branch, slug, create),
    startSession: (slug, target, note) => {
      const scope = origin[0] ? scopeOfRemote(origin[0]) : undefined
      if (!scope) return "no cue scope (origin remote missing)"
      return newSession(pi, ctx, `${scope}/${slug}`, target, note)
    },
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
