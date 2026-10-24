import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { type Loaded, PrBrowser, type PrDeps } from "../prs/browser"
import { PAGE, parseSearch, repoOfRemote, resolveScope, SEARCH_QUERY, searchString, type View } from "../prs/model"

/** Open the GitHub PR browser. */
export const PRS_SHORTCUT = "alt+g"

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
