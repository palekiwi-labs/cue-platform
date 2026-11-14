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

const RUN_ID_PARTS = /^(\d{8}-\d{6}-[0-9a-f]{6})-([a-z0-9-]+)-(\d+)$/

/** A cue-agent run id split into its batch, agent and position in the batch. */
export interface RunId {
  runId: string
  batch: string
  agent: string
  pos: number
}

export function parseRunId(runId: string): RunId | undefined {
  const m = RUN_ID_PARTS.exec(runId)
  if (!m) return undefined
  return { runId, batch: m[1]!, agent: m[2]!, pos: Number(m[3]) }
}

/** What the event history says about one run. */
export interface RunRecord {
  runId: string
  startedAt?: number
  endedAt?: number
  ended: boolean
  cwd?: string
  context?: string
  model?: string
  turns?: number
  cost?: number
  lastError?: string
  lastAborted: boolean
}

/** Runs rebuilt from start, input, error, settled and end events. Other sessions are ignored. */
export class RunHistory {
  readonly runs = new Map<string, RunRecord>()

  apply(event: AgentEvent): void {
    if (!parseRunId(event.sid)) return
    let run = this.runs.get(event.sid)
    if (!run) {
      run = { runId: event.sid, ended: false, lastAborted: false }
      this.runs.set(event.sid, run)
    }
    switch (event.kind) {
      case "start":
        run.startedAt = Math.min(run.startedAt ?? event.ts, event.ts)
        run.ended = false
        run.endedAt = undefined
        run.cwd = str(event.cwd) || run.cwd
        run.context = str(event.context) || run.context
        run.model = str(event.model) || run.model
        return
      case "input":
        run.lastError = undefined
        run.lastAborted = false
        run.context = str(event.context) || run.context
        run.model = str(event.model) || run.model
        return
      case "error":
        run.lastError = str(event.message) || "error"
        return
      case "settled":
        run.lastAborted = event.aborted === true
        return
      case "end":
        run.ended = true
        run.endedAt = event.ts
        run.turns = num(event.turns)
        run.cost = num(event.cost)
        return
    }
  }
}

export type RunStatus = AgentState | "done" | "failed" | "aborted" | "lost"

/** One run as the monitor shows it: live from the registry, else derived from history. */
export interface RunView {
  id: RunId
  status: RunStatus
  live: boolean
  row?: RegistryRow
  record?: RunRecord
}

export function finishedStatus(record: RunRecord | undefined): RunStatus {
  if (!record?.ended) return "lost"
  if (record.lastError) return "failed"
  if (record.lastAborted) return "aborted"
  return "done"
}

/** Join live registry rows (stale ones dropped) with the run history. Headless runs only. */
export function runViews(
  history: RunHistory,
  rows: Iterable<RegistryRow>,
  now: number,
  staleAfterMs = STALE_AFTER_MS,
): RunView[] {
  const live = new Map<string, RegistryRow>()
  for (const row of rows) {
    const runId = row.run_id ?? row.sid
    if (parseRunId(runId) && now - (row.updated_at ?? 0) <= staleAfterMs) live.set(runId, row)
  }
  const ids = new Set([...history.runs.keys(), ...live.keys()])
  const views: RunView[] = []
  for (const runId of ids) {
    const row = live.get(runId)
    const record = history.runs.get(runId)
    views.push({
      id: parseRunId(runId)!,
      status: row ? row.state : finishedStatus(record),
      live: !!row,
      row,
      record,
    })
  }
  return views
}

/** Runs of one batch. */
export interface Batch {
  batch: string
  runs: RunView[]
}

/** Group by batch: batches newest first, runs by position. `running` keeps live runs only. */
export function groupRuns(views: Iterable<RunView>, running: boolean): Batch[] {
  const byBatch = new Map<string, RunView[]>()
  for (const v of views) {
    if (running && !v.live) continue
    const list = byBatch.get(v.id.batch) ?? []
    list.push(v)
    byBatch.set(v.id.batch, list)
  }
  return [...byBatch.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([batch, runs]) => ({
      batch,
      runs: runs.sort((a, b) => a.id.pos - b.id.pos || a.id.agent.localeCompare(b.id.agent)),
    }))
}

export function runStartedAt(view: RunView): number | undefined {
  return view.record?.startedAt ?? view.row?.started_at
}

export function runCost(view: RunView): number | undefined {
  return view.row?.cost ?? view.record?.cost
}

export function runTurns(view: RunView): number | undefined {
  return view.row?.turns ?? view.record?.turns
}

export function runModel(view: RunView): string | undefined {
  return view.row?.model ?? view.record?.model
}

/** One-line outcome: the error of a failed run, the live error, or the last tool. */
export function runNote(view: RunView): string {
  if (view.row) return view.row.state === "error" ? (view.row.error ?? "") : (view.row.last_tool ?? "")
  if (view.status === "failed") return view.record?.lastError ?? ""
  return ""
}

function col(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}~` : text.padEnd(width)
}

/** One list line: status, agent, position, model, turns, cost, age, note. */
export function formatRun(view: RunView, now: number): string {
  const started = runStartedAt(view)
  const turns = runTurns(view)
  return [
    col(view.status, 7),
    col(`${view.id.agent}-${view.id.pos}`, 20),
    col(runModel(view) ?? "-", 24),
    (turns === undefined ? "" : `t${turns}`).padStart(4),
    formatCost(runCost(view)).padStart(8),
    (started === undefined ? "-" : formatAge(now - started)).padStart(4),
    runNote(view),
  ].join("  ")
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
