/**
 * Pure data for the log view: parsing `cue log list` JSON into
 * entries, row markers and preview markdown. Entries are immutable
 * milestone records of one context.
 */

export interface LogEntry {
  /** Stable key within one load: the raw timestamp plus list position. */
  id: string
  /** Unix milliseconds (cue records nanoseconds). */
  timestamp: number
  title: string
  /** Canonical address of a linked trace. */
  trace: string | null
  found: string[]
  decided: string[]
  open: string[]
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s !== "") : []

/** Parse `cue log list` JSON; malformed entries are dropped. */
export function parseLog(stdout: string): LogEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout || "[]")
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: LogEntry[] = []
  parsed.forEach((item, i) => {
    const e = item as Record<string, unknown>
    if (typeof e?.timestamp !== "number" || typeof e.title !== "string") return
    out.push({
      id: `${e.timestamp}:${i}`,
      // Nanoseconds lose precision as a double; milliseconds survive.
      timestamp: Math.floor(e.timestamp / 1e6),
      title: e.title.replace(/\s+/g, " ").trim(),
      trace: typeof e.trace === "string" && e.trace !== "" ? e.trace : null,
      found: strings(e.found),
      decided: strings(e.decided),
      open: strings(e.open),
    })
  })
  return out
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/**
 * Fixed-width (12 columns) local timestamp, as `ls -l` prints it:
 * `Oct 23 23:27` within the current year, `Oct 23  2025` before it.
 */
export function fmtStamp(ms: number, now: number): string {
  const d = new Date(ms)
  const day = `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")}`
  if (d.getFullYear() !== new Date(now).getFullYear()) return `${day}  ${d.getFullYear()}`
  return `${day} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/** Newest first, as the view lists them. */
export function sortLog(entries: readonly LogEntry[]): LogEntry[] {
  return [...entries].sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id))
}

const section = (name: string, items: string[]): string =>
  items.length === 0 ? "" : `**${name}**\n\n${items.map((s) => `- ${s}`).join("\n")}\n\n`

/**
 * Markdown preview: title, found/decided/open, then the linked trace.
 * `trace` is the trace file content; null when it cannot be read.
 */
export function logPreview(e: LogEntry, trace?: string | null): string {
  let md = `# ${e.title}\n\n`
  md += section("Found", e.found) + section("Decided", e.decided) + section("Open", e.open)
  if (e.trace) {
    md += `---\n\n_trace ${e.trace}_\n\n`
    if (trace === undefined || trace === null) md += "_trace not found in this store_\n"
    else {
      const m = /^---\n([\s\S]*?)\n---\n?/.exec(trace)
      md += m ? "```yaml\n" + m[1] + "\n```\n" + trace.slice(m[0].length) : trace
    }
  }
  return md.trimEnd()
}

/** File of an entry's trace below a store root, when linked. */
export function tracePath(e: LogEntry, storeRoot: string): string | null {
  return e.trace ? `${storeRoot}/${e.trace}` : null
}
