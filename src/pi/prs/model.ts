/**
 * Pure model of the GitHub PR browser: the search query, parsing gh's
 * GraphQL response, filter presets, and the rows the view renders (repo
 * headings and stacked PR trees). No I/O here.
 *
 * Both views use one GraphQL search per scope: `repo:<owner>/<name>` in
 * repo view, `org:<org>` per org in org view. One call returns every field
 * a row shows, so nothing is fetched per PR.
 */

export type View = "repo" | "org"
export type Preset = "all" | "mine" | "review"
export const PRESETS: Preset[] = ["all", "mine", "review"]

/** Combined CI state of the head commit; null when it has no checks. */
export type Checks = "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED" | null
export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null

export interface Pr {
  repo: string
  number: number
  title: string
  url: string
  author: string
  isDraft: boolean
  createdAt: string
  reviewDecision: ReviewDecision
  checks: Checks
  baseRef: string
  headRef: string
  defaultBranch: string
  /** Logins of users whose review is requested. */
  reviewers: string[]
}

export interface SearchResult {
  viewer: string
  total: number
  prs: Pr[]
}

/** Search results are capped at one page; `total` tells if more exist. */
export const PAGE = 100

export const SEARCH_QUERY = `query($q: String!) {
  viewer { login }
  search(query: $q, type: ISSUE, first: ${PAGE}) {
    issueCount
    nodes { ... on PullRequest {
      number title url isDraft createdAt reviewDecision baseRefName headRefName
      author { login }
      repository { nameWithOwner defaultBranchRef { name } }
      reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    } }
  }
}`

/** Search string for one scope: an `owner/name` repo or an org. */
export function searchString(view: View, scope: string): string {
  return `is:pr is:open archived:false ${view === "repo" ? "repo" : "org"}:${scope}`
}

/** Parse a `gh api graphql` response for SEARCH_QUERY. Throws on bad JSON. */
export function parseSearch(json: string): SearchResult {
  const data = JSON.parse(json)?.data
  const nodes: any[] = data?.search?.nodes ?? []
  return {
    viewer: data?.viewer?.login ?? "",
    total: data?.search?.issueCount ?? 0,
    prs: nodes
      .filter((n) => n && typeof n.number === "number")
      .map((n) => ({
        repo: n.repository?.nameWithOwner ?? "",
        number: n.number,
        title: n.title ?? "",
        url: n.url ?? "",
        author: n.author?.login ?? "ghost",
        isDraft: !!n.isDraft,
        createdAt: n.createdAt ?? "",
        reviewDecision: n.reviewDecision ?? null,
        checks: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
        baseRef: n.baseRefName ?? "",
        headRef: n.headRefName ?? "",
        defaultBranch: n.repository?.defaultBranchRef?.name ?? "",
        reviewers: (n.reviewRequests?.nodes ?? [])
          .map((r: any) => r?.requestedReviewer?.login)
          .filter((l: unknown): l is string => typeof l === "string"),
      })),
  }
}

/** `owner/name` of a GitHub remote URL (https or ssh); undefined otherwise. */
export function repoOfRemote(url: string): string | undefined {
  const m = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/)
  return m ? `${m[1]}/${m[2]}` : undefined
}

/**
 * Orgs for org view and the view to open in: `cue.gh-org` values win and
 * make org view the default; otherwise the origin owner, repo view.
 */
export function resolveScope(ghOrgs: string[], repo: string | undefined): { orgs: string[]; view: View } {
  const orgs = ghOrgs.map((o) => o.trim()).filter(Boolean)
  if (orgs.length > 0) return { orgs: [...new Set(orgs)], view: "org" }
  const owner = repo?.split("/")[0]
  return { orgs: owner ? [owner] : [], view: "repo" }
}

export const isMine = (pr: Pr, viewer: string): boolean => pr.author === viewer
export const reviewRequested = (pr: Pr, viewer: string): boolean => pr.reviewers.includes(viewer)

export function applyPreset(prs: Pr[], preset: Preset, viewer: string): Pr[] {
  if (preset === "mine") return prs.filter((p) => isMine(p, viewer))
  if (preset === "review") return prs.filter((p) => reviewRequested(p, viewer))
  return prs
}

export type Row =
  | { kind: "repo"; repo: string; count: number; folded: boolean }
  | { kind: "pr"; pr: Pr; depth: number }

/**
 * PRs of one repo as a stacked tree, depth-first. Roots target the default
 * branch or a branch no listed PR heads; children target a parent's head.
 * Siblings are newest first. Cycles cannot loop (visited set).
 */
export function stackRepo(prs: Pr[]): { pr: Pr; depth: number }[] {
  const heads = new Set(prs.map((p) => p.headRef))
  const byBase = new Map<string, Pr[]>()
  for (const p of prs) byBase.set(p.baseRef, [...(byBase.get(p.baseRef) ?? []), p])
  const newest = (a: Pr, b: Pr) => b.createdAt.localeCompare(a.createdAt)
  const out: { pr: Pr; depth: number }[] = []
  const seen = new Set<Pr>()
  const walk = (p: Pr, depth: number) => {
    if (seen.has(p)) return
    seen.add(p)
    out.push({ pr: p, depth })
    for (const c of (byBase.get(p.headRef) ?? []).sort(newest)) walk(c, depth + 1)
  }
  const roots = prs.filter((p) => p.baseRef === p.defaultBranch || !heads.has(p.baseRef))
  for (const r of roots.sort(newest)) walk(r, 0)
  // PRs only reachable through a cycle still show, at the top level.
  for (const p of [...prs].sort(newest)) walk(p, 0)
  return out
}

/**
 * Rows to render. Repo view: the stacked tree, no headings. Org view: one
 * heading per repo (repos with the newest PR first), its tree unless folded.
 */
export function buildRows(prs: Pr[], view: View, folded: ReadonlySet<string>): Row[] {
  if (view === "repo") return stackRepo(prs).map((e) => ({ kind: "pr", ...e }))
  const byRepo = new Map<string, Pr[]>()
  for (const p of prs) byRepo.set(p.repo, [...(byRepo.get(p.repo) ?? []), p])
  const latest = (ps: Pr[]) => ps.reduce((m, p) => (p.createdAt > m ? p.createdAt : m), "")
  const repos = [...byRepo.entries()].sort(
    (a, b) => latest(b[1]).localeCompare(latest(a[1])) || a[0].localeCompare(b[0]),
  )
  const rows: Row[] = []
  for (const [repo, ps] of repos) {
    const isFolded = folded.has(repo)
    rows.push({ kind: "repo", repo, count: ps.length, folded: isFolded })
    if (!isFolded) for (const e of stackRepo(ps)) rows.push({ kind: "pr", ...e })
  }
  return rows
}

/** Compact age: 45s, 12m, 5h, 3d, 7w, 4mo, 2y. */
export function fmtAge(createdAt: string, now: number = Date.now()): string {
  const t = Date.parse(createdAt)
  if (Number.isNaN(t)) return "?"
  const s = Math.max(0, Math.floor((now - t) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  const d = Math.floor(s / 86400)
  if (d < 14) return `${d}d`
  if (d < 60) return `${Math.floor(d / 7)}w`
  if (d < 365) return `${Math.floor(d / 30)}mo`
  return `${Math.floor(d / 365)}y`
}

/** Same rule as cue-review's slugify, for the default review context. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replaceAll("/", "-")
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "")
}

export const reviewContext = (pr: Pr): string => `review-${slugify(pr.headRef)}`

/** Text the fuzzy filter matches against. */
export const haystack = (pr: Pr): string => `${pr.repo} #${pr.number} ${pr.title} ${pr.author} ${pr.headRef}`

/**
 * Worktree already holding `branch`, from `git worktree list --porcelain`.
 */
export function worktreeFor(porcelain: string, branch: string): string | undefined {
  let path: string | undefined
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9)
    else if (line === `branch refs/heads/${branch}`) return path
  }
  return undefined
}

/** Canonical context address check, `<org>/<repo>/<context>`. */
export const isContextAddress = (s: string): boolean => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)
