import { type Breakdown, type Group, analyseBreakdown } from "./breakdown"
import { type CacheSummary, analyseCache, CACHE_TTL_MS } from "./cache"
import { branchPath, type Entry, type SessionHeader } from "./entries"
import { diffSnapshots, isSnapshot, type PartChange, SNAPSHOT_TYPE, type Snapshot, type SnapshotDiff } from "./snapshot"

export type Report = {
  file: string | null
  session: { id: string | null; cwd: string | null; started: string | null }
  contextWindow: number | null
  breakdown: Breakdown
  cache: CacheSummary
  snapshots: number
  prefixChanges: { entryId: string; timestamp: string; diff: SnapshotDiff }[]
}

/** Analyse one session: breakdown, per-turn cache usage, snapshot history. */
export function buildReport(input: {
  entries: Entry[]
  header?: SessionHeader | null
  file?: string | null
  live?: Snapshot | null
  contextWindow?: number | null
}): Report {
  const { entries } = input
  const breakdown = analyseBreakdown(entries, input.live ?? null)
  const cache = analyseCache(entries)
  const prefixChanges: Report["prefixChanges"] = []
  let prev: Snapshot | null = null
  let snapshots = 0
  for (const e of branchPath(entries)) {
    if (e.type !== "custom" || e.customType !== SNAPSHOT_TYPE || !isSnapshot(e.data)) continue
    const s = e.data
    snapshots++
    if (prev && prev.hash !== s.hash) prefixChanges.push({ entryId: e.id, timestamp: e.timestamp, diff: diffSnapshots(prev, s) })
    prev = s
  }
  return {
    file: input.file ?? null,
    session: {
      id: input.header?.id ?? null,
      cwd: input.header?.cwd ?? null,
      started: input.header?.timestamp ?? null,
    },
    contextWindow: input.contextWindow ?? null,
    breakdown,
    cache,
    snapshots,
    prefixChanges,
  }
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function fmtPct(r: number | null): string {
  return r === null ? "-" : `${(r * 100).toFixed(r < 0.1 && r > 0 ? 1 : 0)}%`
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`
  const h = Math.floor(m / 60)
  return `${h}h${String(m % 60).padStart(2, "0")}m`
}

export function bar(share: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round(share * width)))
  return "#".repeat(filled) + ".".repeat(width - filled)
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length)
}

function lpad(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s
}

const PREFIX_NOTE: Record<string, string> = {
  snapshot: "static prefix from context-snapshot entry",
  live: "static prefix from the live session",
  transcript: "static prefix from the recorded system message (text appended by before_agent_start handlers, e.g. cue skill injection, is not recorded and is missing)",
  unknown: "static prefix unknown: no snapshot or recorded system message; message-stream sources only",
}

export type FormatOptions = { top?: number; turns?: number | "all"; misses?: number | "all"; barWidth?: number }

/** Missed tokens and miss count per cause; a miss with several causes counts under each. */
export function missesByCause(c: CacheSummary): { cause: string; count: number; tokens: number }[] {
  const map = new Map<string, { count: number; tokens: number }>()
  for (const t of c.turns) {
    if (!t.miss) continue
    for (const cause of t.miss.causes) {
      const s = map.get(cause) ?? { count: 0, tokens: 0 }
      s.count++
      s.tokens += t.miss.missedTokens
      map.set(cause, s)
    }
  }
  return [...map].map(([cause, s]) => ({ cause, ...s })).sort((a, b) => b.tokens - a.tokens)
}

/** Plain-text lines of the breakdown section. */
export function formatBreakdown(r: Report, opts: FormatOptions = {}): string[] {
  const b = r.breakdown
  const top = opts.top ?? 5
  const barWidth = opts.barWidth ?? 20
  const lines: string[] = []
  const total = b.exact ?? b.estimate
  const window = r.contextWindow
  lines.push(
    `context: ${fmtTokens(total)} tokens${b.exact !== null ? " (exact, last request)" : " (estimate)"}` +
      (window ? ` of ${fmtTokens(window)} window (${fmtPct(total / window)})` : "") +
      (b.model ? `  model ${b.model}` : ""),
  )
  lines.push(`estimate: ${fmtTokens(b.estimate)} raw, scale x${b.scale.toFixed(2)}; trailing after last request: ${fmtTokens(b.trailing)}`)
  lines.push(PREFIX_NOTE[b.prefix])
  const groups: Group[] = ["system", "tools", "messages"]
  const st = b.totals.system.tokens + b.totals.tools.tokens
  lines.push(
    `static prefix ${fmtTokens(Math.round(st * b.scale))} (${fmtPct(b.estimate ? st / b.estimate : null)})` +
      ` / accumulated ${fmtTokens(b.totals.messages.scaled)} (${fmtPct(b.estimate ? b.totals.messages.tokens / b.estimate : null)})`,
  )
  lines.push("")
  lines.push(`${pad("source", 40)} ${lpad("raw", 7)} ${lpad("scaled", 7)} ${lpad("share", 6)}  bar`)
  for (const g of groups) {
    for (const s of b.sources.filter((x) => x.group === g)) {
      lines.push(
        `${pad(s.label, 40)} ${lpad(fmtTokens(s.tokens), 7)} ${lpad(fmtTokens(s.scaled), 7)} ${lpad(fmtPct(s.share), 6)}  ${bar(s.share, barWidth)}`,
      )
      for (const i of s.items.slice(0, top)) {
        lines.push(`  ${pad(i.name.length > 50 ? "..." + i.name.slice(-47) : i.name, 50)} ${lpad(fmtTokens(i.tokens), 7)}`)
      }
      if (s.items.length > top) lines.push(`  (+${s.items.length - top} more)`)
    }
  }
  return lines
}

function describeChange(c: PartChange): string {
  const size = c.change === "changed" ? `${c.before}->${c.after} chars` : c.change === "added" ? `+${c.after} chars` : `-${c.before} chars`
  const items = c.items?.length ? ` [${c.items.map((i) => `${i.name} ${i.change}`).join("; ")}]` : ""
  return `${c.name} ${c.change} (${size})${items}`
}

/** Plain-text lines describing a snapshot diff. */
export function formatDiff(d: SnapshotDiff): string[] {
  if (d.same) return ["identical static prefix"]
  const lines: string[] = []
  if (d.model) lines.push(`model: ${d.model.before} -> ${d.model.after}`)
  for (const s of d.sections) lines.push(`section ${describeChange(s)}`)
  for (const t of d.tools) lines.push(`tool ${describeChange(t)}`)
  if (d.activeAdded.length) lines.push(`active tools added: ${d.activeAdded.join(", ")}`)
  if (d.activeRemoved.length) lines.push(`active tools removed: ${d.activeRemoved.join(", ")}`)
  return lines
}

/** Plain-text lines of the per-turn cache section. */
export function formatCache(r: Report, opts: FormatOptions = {}): string[] {
  const c = r.cache
  const lines: string[] = []
  lines.push(
    `turns ${c.turns.length}  prompt ${fmtTokens(c.totals.prompt)}  cacheRead ${fmtTokens(c.totals.cacheRead)}` +
      `  cacheWrite ${fmtTokens(c.totals.cacheWrite)}  input ${fmtTokens(c.totals.input)}  output ${fmtTokens(c.totals.output)}`,
  )
  lines.push(
    `hit ratio ${fmtPct(c.hitRatio)}${c.reportsCache ? "" : " (provider reported no cache activity)"}` +
      `  misses ${c.misses} (${fmtTokens(c.missedTokens)} tokens)  compactions ${c.compactions}` +
      (c.compactionRebuilds ? ` (rebuilds ${fmtTokens(c.compactionTokens)} tokens)` : ""),
  )
  const misses = c.turns.filter((t) => t.miss)
  if (misses.length) {
    lines.push(
      `by cause: ${missesByCause(c)
        .map((m) => `${m.cause} ${m.count} (${fmtTokens(m.tokens)})`)
        .join(", ")}`,
    )
    const missLimit = opts.misses ?? 10
    const big = [...misses].sort((a, b) => b.miss!.missedTokens - a.miss!.missedTokens)
    const listed = missLimit === "all" ? misses : big.slice(0, missLimit).sort((a, b) => a.index - b.index)
    lines.push("")
    lines.push(listed.length < misses.length ? `largest ${listed.length} of ${misses.length} misses:` : "misses:")
    for (const t of listed) {
      const m = t.miss!
      const why = m.causes
        .map((k) =>
          k === "idle" ? `idle ${fmtDuration(m.idleMs)} > ${fmtDuration(CACHE_TTL_MS)} TTL` : k === "model" ? "model change" : k,
        )
        .join(", ")
      const at = new Date(t.timestamp).toISOString().slice(11, 19)
      lines.push(`  turn ${t.index} ${at}  ${fmtTokens(m.missedTokens)} missed  ${why}`)
      for (const p of m.prefixChanges.slice(0, 4)) lines.push(`    ${p}`)
    }
  }
  const limit = opts.turns ?? 12
  const shown = limit === "all" ? c.turns : c.turns.slice(-limit)
  if (shown.length) {
    lines.push("")
    lines.push(
      `${lpad("turn", 4)} ${pad("time", 8)} ${lpad("input", 7)} ${lpad("cRead", 7)} ${lpad("cWrite", 7)} ${lpad("output", 7)} ${lpad("context", 7)} ${lpad("hit", 5)}  note`,
    )
    if (shown.length < c.turns.length) lines.push(`  (${c.turns.length - shown.length} earlier turns)`)
    for (const t of shown) {
      const note = [t.afterCompaction ? "after compaction" : "", t.miss ? `miss ${t.miss.causes.join("+")}` : ""].filter(Boolean).join(", ")
      lines.push(
        `${lpad(String(t.index), 4)} ${pad(new Date(t.timestamp).toISOString().slice(11, 19), 8)} ${lpad(fmtTokens(t.input), 7)} ${lpad(fmtTokens(t.cacheRead), 7)} ${lpad(fmtTokens(t.cacheWrite), 7)} ${lpad(fmtTokens(t.output), 7)} ${lpad(fmtTokens(t.context), 7)} ${lpad(fmtPct(t.hitRatio), 5)}  ${note}`,
      )
    }
  }
  return lines
}

/** Full plain-text report. */
export function formatReport(r: Report, opts: FormatOptions = {}): string {
  const lines: string[] = []
  if (r.file) lines.push(`session: ${r.file}`)
  if (r.session.cwd) lines.push(`cwd: ${r.session.cwd}  started ${r.session.started ?? "?"}`)
  lines.push(`snapshots: ${r.snapshots}${r.prefixChanges.length ? `, prefix changed ${r.prefixChanges.length} time(s)` : ""}`)
  lines.push("")
  lines.push("== breakdown ==")
  lines.push(...formatBreakdown(r, opts))
  lines.push("")
  lines.push("== cache ==")
  lines.push(...formatCache(r, opts))
  if (r.prefixChanges.length) {
    lines.push("")
    lines.push("== prefix changes within session ==")
    for (const p of r.prefixChanges) {
      lines.push(`${p.timestamp} (${p.entryId}):`)
      for (const l of formatDiff(p.diff)) lines.push(`  ${l}`)
    }
  }
  return lines.join("\n")
}
