/**
 * Pure data for the activity view: parsing `cue activity list --json`
 * into events, kind labels and colours, list summaries and preview
 * markdown. Kinds are open-ended (cue reserves only artifact_created),
 * so unknown kinds render raw in a neutral colour.
 */


import type { Theme } from "@earendil-works/pi-coding-agent"

export interface ActivityEvent {
  id: string
  /** Unix milliseconds, as recorded by cue. */
  timestamp: number
  kind: string
  host: string | null
  harness: string | null
  sessionId: string | null
  details: Record<string, unknown>
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null

/** Parse `cue activity list --json`; malformed entries are dropped. */
export function parseActivity(stdout: string): ActivityEvent[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout || "[]")
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: ActivityEvent[] = []
  for (const item of parsed) {
    const e = item as Record<string, unknown>
    const id = str(e?.id)
    const kind = str(e?.kind)
    if (!id || !kind || typeof e?.timestamp !== "number") continue
    out.push({
      id,
      timestamp: e.timestamp,
      kind,
      host: str(e.host),
      harness: str(e.harness),
      sessionId: str(e.session_id),
      details:
        e.details && typeof e.details === "object"
          ? (e.details as Record<string, unknown>)
          : {},
    })
  }
  return out
}

/** Newest first, as the view lists them. */
export function sortActivity(events: readonly ActivityEvent[]): ActivityEvent[] {
  return [...events].sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id))
}

export interface KindLabel {
  label: string
  color: Parameters<Theme["fg"]>[0]
}

const KNOWN_KINDS: Record<string, KindLabel> = {
  git_commit: { label: "COMMIT", color: "success" },
  artifact_created: { label: "ARTIFACT", color: "accent" },
  session_associated: { label: "SESSION", color: "muted" },
  log_compaction_started: { label: "COMPACT", color: "muted" },
  log_compacted: { label: "COMPACT", color: "muted" },
}

/** Short badge for a known kind; the raw kind, dim, for anything else. */
export function kindLabel(kind: string): KindLabel {
  return KNOWN_KINDS[kind] ?? { label: kind.slice(0, 8), color: "dim" }
}

/** Compact date-time: 6d 14:03, or the full date past a week. */
export function fmtWhen(ms: number, now: number): string {
  const d = new Date(ms)
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  const days = Math.floor((now - ms) / 86400_000)
  if (days < 1) return `today ${hhmm}`
  if (days < 7) return `${days}d ${hhmm}`
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/**
 * One-line summary of an event: the commit title, the artifact
 * address, the association method, a compaction run's sizes; details
 * JSON as the fallback.
 */
export function eventSummary(e: ActivityEvent): string {
  const d = e.details
  if (e.kind === "git_commit" && typeof d.title === "string" && d.title !== "") {
    return d.title.replace(/\s+/g, " ").trim()
  }
  if (e.kind === "artifact_created") {
    const address = str(d.address) ?? str(d.type)
    if (address) return address
  }
  if (e.kind === "session_associated" && typeof d.method === "string") {
    return d.method
  }
  if (e.kind === "log_compaction_started") {
    const entries = typeof d.entries === "number" ? d.entries : null
    const head = typeof d.head === "number" ? d.head : null
    if (entries !== null && head !== null) return `start: head ${head} of ${entries}`
    return "compaction started"
  }
  if (e.kind === "log_compacted") {
    const before = typeof d.entries_before === "number" ? d.entries_before : null
    const replaced = typeof d.replaced === "number" ? d.replaced : null
    const summaries = Array.isArray(d.summaries) ? d.summaries.length : null
    if (before !== null && replaced !== null && summaries !== null) {
      const after = before - replaced + summaries
      return `${before} → ${after} entries (${replaced} → ${summaries} summaries)`
    }
    return "log compacted"
  }
  return JSON.stringify(d)
}

export interface CommitDetails {
  hash: string
  branch: string
  title: string
  repo: string | null
  root: string | null
}

/** git_commit details when they carry a resolved hash. */
export function commitDetails(e: ActivityEvent): CommitDetails | null {
  const d = e.details
  if (typeof d.hash !== "string" || d.hash === "") return null
  return {
    hash: d.hash,
    branch: str(d.branch) ?? "",
    title: str(d.title) ?? "",
    repo: str(d.repo),
    root: str(d.root),
  }
}

const FULL_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * What an event points at, as text to copy: a session's file path, an
 * artifact's address, a commit as `<org>/<repo>@<hash>`, a compaction
 * run's dir. When the event
 * lacks it, the reason instead; nothing is guessed.
 */
export function eventValue(
  e: ActivityEvent,
  sessionFile: (sessionId: string) => string | undefined,
): { text: string } | { missing: string } {
  if (e.kind === "session_associated") {
    const path = e.sessionId ? sessionFile(e.sessionId) : undefined
    return path ? { text: path } : { missing: "session file not found on this host" }
  }
  if (e.kind === "artifact_created") {
    const address = str(e.details.address)
    return address ? { text: address } : { missing: "artifact event has no address" }
  }
  if (e.kind === "git_commit") {
    const c = commitDetails(e)
    if (!c || !FULL_HASH.test(c.hash)) return { missing: "commit event has no full hash" }
    if (!c.repo) return { missing: "commit event has no repo" }
    return { text: `${c.repo}@${c.hash}` }
  }
  if (e.kind === "log_compaction_started" || e.kind === "log_compacted") {
    const runDir = str(e.details.run_dir)
    return runDir ? { text: runDir } : { missing: "compaction event has no run dir" }
  }
  return { missing: `nothing to copy for ${e.kind}` }
}

const capLines =(text: string, max: number): string => {
  const lines = text.split("\n")
  return lines.length <= max
    ? text
    : `${lines.slice(0, max).join("\n")}\n… (${lines.length - max} more lines)`
}

/**
 * Markdown preview of an event: the thing the event points at, and
 * nothing else. `gitShow` is `git show --stat --patch` output for a
 * commit; `artifact` is the created artifact's file content;
 * `sessionPreview` is the rendered session transcript. When the target
 * cannot be found, the event record is shown instead.
 */
export function eventPreview(
  e: ActivityEvent,
  extras: {
    gitShow?: string | null
    artifact?: string | null
    sessionPreview?: string | null
  } = {},
): string {
  const record = "```json\n" + JSON.stringify(e.details, null, 2) + "\n```"
  const missing = (what: string) => `_${what}_\n\n${record}`
  if (e.kind === "git_commit") {
    const c = commitDetails(e)
    if (extras.gitShow && c) {
      const where = c.repo ?? (c.root ? c.root.split("/").pop() : null)
      const head = `**${where ?? "unknown repo"}** \`${c.branch || "?"}\` \`${c.hash}\`${c.root ? ` — ${c.root}` : ""}`
      return `${head}\n\n\`\`\`diff\n${capLines(extras.gitShow, 1000)}\n\`\`\``
    }
    return c ? missing("commit not found on this host") : record
  }
  if (e.kind === "artifact_created" && str(e.details.address)) {
    const text = extras.artifact
    if (text === undefined || text === null) return missing("artifact not found in this store")
    const m = /^---\n([\s\S]*?)\n---\n?/.exec(text)
    return m ? "```yaml\n" + m[1] + "\n```\n" + text.slice(m[0].length) : text
  }
  if (e.kind === "session_associated") {
    return extras.sessionPreview || missing("session file not found on this host")
  }
  return record
}

/** Name of an artifact event's file below a store root, when known. */
export function artifactPath(e: ActivityEvent, storeRoot: string): string | null {
  const address = str(e.details.address)
  return address ? `${storeRoot}/${address}` : null
}