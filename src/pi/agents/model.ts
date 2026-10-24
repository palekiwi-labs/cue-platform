/**
 * Data model of the cue-agent monitor: flattens `cue-agent ps --all --json`
 * into one row per run. Pure functions only; the picker renders them.
 */

export type BatchState = "running" | "finalizing" | "finished" | "crashed"

export interface RunRow {
  batchId: string
  batchLabel: string | null
  batchState: BatchState
  /** Unix seconds. */
  startedAt: number
  runId: string
  agent: string
  model: string
  position: number
  /** preparing | running | finishing | finished | crashed */
  phase: string
  runPath: string
  elapsedSecs: number | null
  tokensInput: number | null
  tokensOutput: number | null
  costUsd: number | null
  /** completed | failed | timeout | aborted, once the run has a receipt. */
  outcome: string | null
  response: string | null
  error: string | null
}

/** Per-run fields ps does not report; read from the run's manifest.json. */
export interface RunManifest {
  label: string | null
  context: string | null
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null)
const num = (v: unknown): number | null => (typeof v === "number" ? v : null)

/** Rows of `cue-agent ps --all --json`, newest batch first, runs in order. */
export function parsePs(json: string): RunRow[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  const batches = (parsed as { batches?: unknown })?.batches
  if (!Array.isArray(batches)) return []
  const rows: RunRow[] = []
  for (const b of batches as Record<string, unknown>[]) {
    const batchId = str(b.batch_id)
    if (!batchId || !Array.isArray(b.runs)) continue
    const runs = (b.runs as Record<string, unknown>[])
      .slice()
      .sort((x, y) => (num(x.position) ?? 0) - (num(y.position) ?? 0))
    for (const r of runs) {
      const runId = str(r.run_id)
      if (!runId) continue
      const result = (r.result ?? null) as Record<string, unknown> | null
      rows.push({
        batchId,
        batchLabel: str(b.label),
        batchState: (str(b.state) ?? "finished") as BatchState,
        startedAt: num(b.started_at) ?? 0,
        runId,
        agent: str(r.agent) ?? "?",
        model: str(r.model) ?? "",
        position: num(r.position) ?? 0,
        phase: str(r.phase) ?? "",
        runPath: str(r.run_path) ?? "",
        elapsedSecs: num(r.elapsed_secs),
        tokensInput: num(r.tokens_input),
        tokensOutput: num(r.tokens_output),
        costUsd: num(r.cost_usd),
        outcome: result ? str(result.outcome) : null,
        response: result ? str(result.response) : null,
        error: result ? str(result.error) : null,
      })
    }
  }
  rows.sort((a, b) => (a.batchId === b.batchId ? a.position - b.position : a.batchId < b.batchId ? 1 : -1))
  return rows
}

/** Label and context from a run's manifest.json; nulls when unreadable. */
export function parseManifest(json: string): RunManifest {
  try {
    const m = JSON.parse(json) as Record<string, unknown>
    return { label: str(m.label), context: str(m.context) }
  } catch {
    return { label: null, context: null }
  }
}

/** What the row shows as its state: the outcome once known, else the phase. */
export function runState(r: RunRow): string {
  if (r.outcome) return r.outcome
  if (r.batchState === "crashed") return "crashed"
  return r.phase || r.batchState
}

/** Still going: the batch supervisor is alive and the run has no receipt. */
export function isLive(r: RunRow): boolean {
  return (r.batchState === "running" || r.batchState === "finalizing") && r.outcome === null
}

export type StateTone = "live" | "ok" | "bad" | "dim"

export function stateTone(state: string): StateTone {
  switch (state) {
    case "completed":
      return "ok"
    case "failed":
    case "timeout":
    case "aborted":
    case "crashed":
      return "bad"
    case "preparing":
    case "running":
    case "finishing":
    case "finalizing":
      return "live"
    default:
      return "dim"
  }
}

export function fmtDuration(secs: number | null): string {
  if (secs === null) return "-"
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}`
  return `${Math.floor(secs / 3600)}h${String(Math.floor((secs % 3600) / 60)).padStart(2, "0")}`
}

export function fmtTokens(n: number | null): string {
  if (n === null) return "-"
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
}

export function fmtCost(usd: number | null): string {
  if (usd === null) return "-"
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`
}

/** The label a row shows: the task label, else the batch label. */
export function rowLabel(r: RunRow, m: RunManifest | undefined): string {
  return m?.label ?? r.batchLabel ?? ""
}

/** Text the fuzzy query matches against. */
export function haystack(r: RunRow, m: RunManifest | undefined): string {
  return [m?.label, r.batchLabel, r.agent, r.model, m?.context, r.batchId]
    .filter(Boolean)
    .join(" ")
}

/** One batch and its runs in position order, as the monitor groups them. */
export interface BatchGroup {
  batchId: string
  label: string | null
  state: BatchState
  runs: RunRow[]
}

/**
 * Group rows by batch, keeping the order of first appearance. Feed it rows
 * in parsePs order so groups stay newest first and runs stay in position
 * order no matter what filtering happened in between.
 */
export function groupBatches(rows: RunRow[]): BatchGroup[] {
  const groups = new Map<string, BatchGroup>()
  for (const r of rows) {
    let g = groups.get(r.batchId)
    if (!g) {
      g = { batchId: r.batchId, label: r.batchLabel, state: r.batchState, runs: [] }
      groups.set(r.batchId, g)
    }
    g.runs.push(r)
  }
  return [...groups.values()]
}

export interface BatchTotals {
  done: number
  total: number
  /** Longest run: runs in a batch go in parallel, so it bounds wall time. */
  elapsedSecs: number | null
  tokensInput: number | null
  costUsd: number | null
}

const sum = (xs: (number | null)[]): number | null =>
  xs.some((x) => x !== null) ? xs.reduce<number>((a, x) => a + (x ?? 0), 0) : null

export function batchTotals(g: BatchGroup): BatchTotals {
  const elapsed = g.runs.map((r) => r.elapsedSecs).filter((x): x is number => x !== null)
  return {
    done: g.runs.filter((r) => r.outcome !== null).length,
    total: g.runs.length,
    elapsedSecs: elapsed.length ? Math.max(...elapsed) : null,
    tokensInput: sum(g.runs.map((r) => r.tokensInput)),
    costUsd: sum(g.runs.map((r) => r.costUsd)),
  }
}
