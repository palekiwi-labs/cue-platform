/**
 * Pure data for the cue browser: parsing CLI JSON into rows, artifact
 * ordering and compact ages. Ported from cue.nvim (core.lua, config.lua)
 * where cue does not already provide it; the context tree itself and
 * its recency order come from `cue context tree`.
 */

export interface ContextRow {
  address: string
  scope: string
  slug: string
  title: string
  mode: string | null
  kind: string | null
  pinned: boolean
  /** Unix seconds of the newest log entry, or null when never logged. */
  lastLoggedAt: number | null
  /** Absolute path of context.md. */
  path: string
  depth: number
  /** One flag per ancestor level below the root: does it have more siblings. */
  connectors: boolean[]
  isLast: boolean
}

export interface ArtifactRow {
  path: string
  name: string
  type: string
  title: string
  status: string | null
  priority: string | null
  /** Unix seconds, or null when unknown. */
  createdAt: number | null
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null

/**
 * Flatten `cue context tree --json` into rows in CLI order (subtree
 * recency). Malformed nodes are dropped with their subtrees.
 */
export function parseContextTree(stdout: string): ContextRow[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout || "{}")
  } catch {
    return []
  }
  const roots = (parsed as { roots?: unknown })?.roots
  if (!Array.isArray(roots)) return []
  const out: ContextRow[] = []
  const visit = (
    node: unknown,
    depth: number,
    connectors: boolean[],
    isLast: boolean,
  ): void => {
    const n = node as Record<string, unknown>
    const slug = str(n?.context)
    const scope = str(n?.scope)
    if (!slug || !scope) return
    out.push({
      address: `${scope}/${slug}`,
      scope,
      slug,
      title: str(n.title) ?? slug,
      mode: str(n.mode),
      kind: str(n.kind),
      pinned: n.pinned === true,
      lastLoggedAt: num(n.last_logged_at),
      path: str(n.path) ?? "",
      depth,
      connectors,
      isLast,
    })
    // Roots render flush left: their siblings are other trees, not a rail.
    const next = depth > 0 ? [...connectors, !isLast] : [...connectors]
    const kids = Array.isArray(n.children) ? n.children : []
    kids.forEach((kid, i) => visit(kid, depth + 1, next, i === kids.length - 1))
  }
  roots.forEach((r, i) => visit(r, 0, [], i === roots.length - 1))
  return out
}

/** Connector cell: "│ "/"  " per ancestor level, then "├─"/"└─"; "" for roots. */
export function treePrefix(row: Pick<ContextRow, "depth" | "connectors" | "isLast">): string {
  if (row.depth === 0) return ""
  let out = ""
  for (let i = 0; i < row.depth - 1; i++) out += row.connectors[i] ? "│ " : "  "
  return out + (row.isLast ? "└─" : "├─")
}

/** `tmp/<19-digit-nanos>-<hash>/...`: creation time lives in the path. */
const TMP_STAMP = /\/tmp\/(\d{19})-[^/]+\//

/** Parse `cue list --json --frontmatter` into artifact rows. */
export function parseArtifacts(stdout: string): ArtifactRow[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout || "[]")
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: ArtifactRow[] = []
  for (const item of parsed) {
    const a = item as Record<string, unknown>
    const path = str(a?.path)
    const name = str(a?.name)
    const type = str(a?.type)
    if (!path || !name || !type) continue
    const fm = (a.frontmatter ?? {}) as Record<string, unknown>
    let createdAt = num(fm.created_at)
    if (createdAt === null) {
      const m = TMP_STAMP.exec(path)
      if (m) createdAt = Math.floor(Number(m[1]) / 1e9)
    }
    out.push({
      path,
      name,
      type,
      title: str(fm.title) ?? name,
      status: str(fm.status),
      priority: str(fm.priority),
      createdAt,
    })
  }
  return out
}

export const TYPE_ORDER = [
  "task",
  "spec",
  "plan",
  "note",
  "trace",
  "review",
  "bin",
  "tmp",
] as const

const typeRank = (t: string): number => {
  const i = (TYPE_ORDER as readonly string[]).indexOf(t)
  return i === -1 ? 99 : i
}

export const isFinished = (status: string | null): boolean =>
  status === "complete" || status === "closed"

/**
 * cue.nvim order: by type, unfinished before finished, newest first,
 * then title, name and path for stability.
 */
export function compareArtifacts(a: ArtifactRow, b: ArtifactRow): number {
  return (
    typeRank(a.type) - typeRank(b.type) ||
    Number(isFinished(a.status)) - Number(isFinished(b.status)) ||
    (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
    a.title.localeCompare(b.title) ||
    a.name.localeCompare(b.name) ||
    a.path.localeCompare(b.path)
  )
}

export function sortArtifacts(rows: readonly ArtifactRow[]): ArtifactRow[] {
  return [...rows].sort(compareArtifacts)
}

/** Compact age: now, 12m, 3h, 6d, 1y; "—" when unknown. */
export function relativeAge(ts: number | null, now: number): string {
  if (ts === null) return "—"
  const s = Math.max(0, now - ts)
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 86400 * 365) return `${Math.floor(s / 86400)}d`
  return `${Math.floor(s / (86400 * 365))}y`
}

const BADGES: Record<string, string> = {
  task: "TASK",
  spec: "SPEC",
  plan: "PLAN",
  note: "NOTE",
  trace: "TRACE",
  review: "REV",
  bin: "BIN",
  tmp: "TMP",
}

export const typeBadge = (type: string): string =>
  BADGES[type] ?? type.toUpperCase().slice(0, 5)

/**
 * Canonical address of an artifact: its path below the context's
 * directory, prefixed by the context address. Undefined when the path
 * does not lie inside that context.
 */
export function artifactAddress(contextAddress: string, path: string): string | undefined {
  const marker = `/${contextAddress}/`
  const i = path.lastIndexOf(marker)
  return i === -1 ? undefined : path.slice(i + 1)
}

/** Artifact types the creation wizard offers, in menu order. */
export const CREATE_TYPES = ["note", "task", "plan", "spec", "trace"] as const

/**
 * Filename for a new artifact. In slug mode the input is reduced to a
 * single kebab-case segment; in path mode nested segments are kept and
 * each one is cleaned. `.md` is appended when missing. Undefined when
 * nothing usable remains or the path tries to escape.
 */
export function artifactFilename(input: string, asPath: boolean): string | undefined {
  const clean = (s: string) =>
    s.toLowerCase().trim().replace(/\.md$/, "").replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
  const parts = asPath ? input.split("/") : [input]
  const segs = parts.map(clean).filter((s) => s !== "")
  if (segs.length === 0 || segs.some((s) => s === "." || s === "..")) return undefined
  return `${segs.join("/")}.md`
}
