import type { AgentEvent, AgentState, RegistryRow } from "./events"

export const STALE_AFTER_MS = 120 * 1000
export const MAX_ACTIVITY = 200

/** Minimal shape of a KV watch entry the monitor needs. */
export interface RegistryEntry {
  key: string
  operation: string
  value: () => string
}

/** Apply one KV watch entry to the row map. Malformed values remove the row. */
export function applyRegistryEntry(rows: Map<string, RegistryRow>, entry: RegistryEntry): void {
  if (entry.operation !== "PUT") {
    rows.delete(entry.key)
    return
  }
  try {
    const row = JSON.parse(entry.value()) as RegistryRow
    if (row && typeof row === "object" && typeof row.sid === "string") rows.set(entry.key, row)
    else rows.delete(entry.key)
  } catch {
    rows.delete(entry.key)
  }
}

const ACTIVE: ReadonlySet<AgentState> = new Set(["busy", "waiting-input", "error"])

/** Active rows first, then most recently updated. */
export function sortRows(rows: Iterable<RegistryRow>): RegistryRow[] {
  return [...rows].sort((a, b) => {
    const rank = Number(!ACTIVE.has(a.state)) - Number(!ACTIVE.has(b.state))
    if (rank !== 0) return rank
    if (b.updated_at !== a.updated_at) return b.updated_at - a.updated_at
    return a.sid.localeCompare(b.sid)
  })
}

export interface RowFilter {
  showAll: boolean
  now: number
  staleAfterMs?: number
}

/** Rows to display: delegated runs unless `showAll`, never stale ones; sorted. */
export function visibleRows(rows: Iterable<RegistryRow>, filter: RowFilter): RegistryRow[] {
  const stale = filter.staleAfterMs ?? STALE_AFTER_MS
  const kept = [...rows].filter(
    (r) => (filter.showAll || !!r.run_id) && filter.now - (r.updated_at ?? 0) <= stale,
  )
  return sortRows(kept)
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function formatCost(cost: number | undefined): string {
  return `$${(cost ?? 0).toFixed(3)}`
}

function col(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}~` : text.padEnd(width)
}

/** One list line: state, run id (or sid), model, turns, cost, age, last tool. */
export function formatRow(row: RegistryRow, now: number): string {
  return [
    col(row.state, 13),
    col(row.run_id ?? row.sid, 40),
    col(row.model ?? "-", 24),
    `t${row.turns ?? 0}`.padStart(4),
    formatCost(row.cost).padStart(8),
    formatAge(now - (row.started_at ?? now)).padStart(4),
    row.last_tool ?? "",
  ].join("  ")
}

export type ActivityItem =
  | {
      kind: "tool"
      callId: string
      tool: string
      args: string
      status: "running" | "ok" | "error"
      durationMs?: number
    }
  | { kind: "input"; source: string; preview: string }
  | { kind: "thinking" }
  | { kind: "error"; message: string }
  | { kind: "settled"; aborted: boolean }
  | { kind: "compact"; reason: string }
  | { kind: "end"; reason: string; turns?: number; cost?: number }

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}

/** Recent activity of one session, built from its events. Keeps the last `max` items. */
export class ActivityLog {
  readonly items: ActivityItem[] = []

  constructor(private readonly max = MAX_ACTIVITY) {}

  add(event: AgentEvent): void {
    switch (event.kind) {
      case "tool_start":
        this.push({
          kind: "tool",
          callId: str(event.call_id),
          tool: str(event.tool),
          args: str(event.args),
          status: "running",
        })
        return
      case "tool_end": {
        const callId = str(event.call_id)
        const status = event.ok === false ? "error" : "ok"
        const durationMs = num(event.duration_ms)
        for (let i = this.items.length - 1; i >= 0; i--) {
          const item = this.items[i]!
          if (item.kind === "tool" && item.callId === callId) {
            item.status = status
            item.durationMs = durationMs
            return
          }
        }
        this.push({ kind: "tool", callId, tool: str(event.tool), args: "", status, durationMs })
        return
      }
      case "input":
        this.push({ kind: "input", source: str(event.source), preview: str(event.preview) })
        return
      case "thinking":
        this.push({ kind: "thinking" })
        return
      case "error":
        this.push({ kind: "error", message: str(event.message) })
        return
      case "settled":
        this.push({ kind: "settled", aborted: event.aborted === true })
        return
      case "compact":
        this.push({ kind: "compact", reason: str(event.reason) })
        return
      case "end":
        this.push({ kind: "end", reason: str(event.reason), turns: num(event.turns), cost: num(event.cost) })
        return
    }
  }

  private push(item: ActivityItem): void {
    this.items.push(item)
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max)
  }
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return ""
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return formatAge(ms)
}

const TOOL_MARK = { running: "..", ok: "ok", error: "ERR" } as const

/** Plain-text line for one activity item. */
export function formatActivity(item: ActivityItem): string {
  switch (item.kind) {
    case "tool": {
      const duration = formatDuration(item.durationMs)
      const parts = [TOOL_MARK[item.status].padEnd(3), item.tool, item.args].filter(Boolean)
      return duration ? `${parts.join(" ")} (${duration})` : parts.join(" ")
    }
    case "input":
      return `> [${item.source || "input"}] ${item.preview}`
    case "thinking":
      return "thinking"
    case "error":
      return `error: ${item.message}`
    case "settled":
      return item.aborted ? "settled (aborted)" : "settled"
    case "compact":
      return `compact (${item.reason})`
    case "end": {
      const extra = [item.turns === undefined ? "" : `${item.turns} turns`, item.cost === undefined ? "" : formatCost(item.cost)]
        .filter(Boolean)
        .join(", ")
      return extra ? `end (${item.reason}) ${extra}` : `end (${item.reason})`
    }
  }
}
