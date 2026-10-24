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
 * address, the association method; details JSON as the fallback.
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
    return `session ${d.method}`
  }
  return JSON.stringify(d)
}

/** Provenance line under the preview heading. */
export function provenanceLine(e: ActivityEvent): string {
  const who = [e.harness, e.host].filter(Boolean).join("@") || "unknown"
  const session = e.sessionId ? `, session ${e.sessionId.slice(0, 8)}` : ""
  return `${who}${session}`
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

const capLines = (text: string, max: number): string => {
  const lines = text.split("\n")
  return lines.length <= max
    ? text
    : `${lines.slice(0, max).join("\n")}\n… (${lines.length - max} more lines)`
}

/**
 * Markdown preview of an event. `gitShow` is the `git show` output for
 * a commit (already truncated by the caller if desired); `artifact` is
 * the created artifact's file content; `sessionPreview` is the
 * rendered session description/transcript.
 */
export function eventPreview(
  e: ActivityEvent,
  extras: {
    gitShow?: string | null
    artifact?: string | null
    sessionPreview?: string | null
  } = {},
): string {
  const parts = [
    `# ${kindLabel(e.kind).label.toLowerCase()} ${new Date(e.timestamp).toLocaleString()}`,
    provenanceLine(e),
  ]
  const d = e.details
  if (e.kind === "git_commit") {
    const c = commitDetails(e)
    if (c) {
      const repo = c.repo ?? c.root ?? ""
      parts.push(`**${c.title}**\n\n\`${c.hash.slice(0, 10)}\` on \`${c.branch}\`${repo ? ` in ${repo}` : ""}`)
      if (extras.gitShow) {
        parts.push("```diff\n" + capLines(extras.gitShow, 1000) + "\n```")
      } else {
        parts.push("_commit not found in this checkout_")
      }
    } else {
      parts.push("```sh\n" + String(d.command ?? JSON.stringify(d, null, 2)) + "\n```")
    }
    return parts.join("\n\n")
  }
  if (e.kind === "artifact_created" && str(d.address)) {
    parts.push(`\`${d.address}\``)
    if (extras.artifact !== undefined && extras.artifact !== null) {
      const m = /^---\n([\s\S]*?)\n---\n?/.exec(extras.artifact)
      const body = m ? extras.artifact.slice(m[0].length) : extras.artifact
      parts.push(m ? "```yaml\n" + m[1] + "\n```" : "")
      if (body.trim() !== "") parts.push(body.trim())
    } else {
      parts.push("_artifact not found in this store_")
    }
    return parts.filter((p) => p !== "").join("\n\n")
  }
  if (e.kind === "session_associated") {
    if (extras.sessionPreview) parts.push(extras.sessionPreview)
    else parts.push("_session file not found on this host_")
    return parts.join("\n\n---\n\n")
  }
  parts.push("```json\n" + JSON.stringify(e.details, null, 2) + "\n```")
  return parts.join("\n\n")
}

/** Name of an artifact event's file below a store root, when known. */
export function artifactPath(e: ActivityEvent, storeRoot: string): string | null {
  const address = str(e.details.address)
  return address ? `${storeRoot}/${address}` : null
}