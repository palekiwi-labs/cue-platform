/**
 * Data model of the cue-agent monitor: flattens `cue-agent ps --all --json`
 * into one row per run. Pure functions only; the picker renders them.
 */

export type BatchState = "running" | "finalizing" | "finished" | "crashed"

export interface RunRow {
  batchId: string
  batchLabel: string | null
  batchState: BatchState
  /** Groups batches of one unit of work; null for a standalone batch. */
  jobId: string | null
  jobLabel: string | null
  /** Unix seconds. */
  startedAt: number
  runId: string
  /** Task label, else batch label, as cue-agent reports it. */
  label: string | null
  context: string | null
  agent: string
  model: string
  position: number
  /** preparing | running | finishing | finished | crashed */
  phase: string
  runPath: string
  elapsedSecs: number | null
  tokensInput: number | null
  tokensOutput: number | null
  tokensCacheRead: number | null
  tokensCacheWrite: number | null
  costUsd: number | null
  /** completed | failed | timeout | aborted, once the run has a receipt. */
  outcome: string | null
  response: string | null
  error: string | null
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
    const job = (b.job ?? null) as Record<string, unknown> | null
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
        jobId: job ? str(job.id) : null,
        jobLabel: job ? str(job.label) : null,
        startedAt: num(b.started_at) ?? 0,
        runId,
        label: str(r.label),
        context: str(r.context),
        agent: str(r.agent) ?? "?",
        model: str(r.model) ?? "",
        position: num(r.position) ?? 0,
        phase: str(r.phase) ?? "",
        runPath: str(r.run_path) ?? "",
        elapsedSecs: num(r.elapsed_secs),
        tokensInput: num(r.tokens_input),
        tokensOutput: num(r.tokens_output),
        tokensCacheRead: num(r.tokens_cache_read),
        tokensCacheWrite: num(r.tokens_cache_write),
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
    // Harness gone, waiting for its batch: not working, so not live-coloured.
    case "exited":
      return "dim"
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
  // At most six characters, the width of the monitor's token column.
  if (n < 1000) return `${n}`
  if (n < 999_950) return `${(n / 1000).toFixed(1)}k`
  if (n < 99_995_000) return `${(n / 1_000_000).toFixed(2)}M`
  return `${Math.round(n / 1_000_000)}M`
}

export function fmtCost(usd: number | null): string {
  if (usd === null) return "-"
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`
}

/** Input tokens including cache reads and writes, comparable across models. */
export function inputTokens(r: RunRow): number | null {
  if (r.tokensInput === null) return null
  return r.tokensInput + (r.tokensCacheRead ?? 0) + (r.tokensCacheWrite ?? 0)
}

/** Text the fuzzy query matches against. */
export function haystack(r: RunRow): string {
  return [r.label, r.batchLabel, r.jobLabel, r.agent, r.model, r.context, r.batchId, r.jobId]
    .filter(Boolean)
    .join(" ")
}

/** One batch and its runs in position order, as the monitor groups them. */
export interface BatchGroup {
  batchId: string
  label: string | null
  state: BatchState
  /** Unix seconds. */
  startedAt: number
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
      g = { batchId: r.batchId, label: r.batchLabel, state: r.batchState, startedAt: r.startedAt, runs: [] }
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
    tokensInput: sum(g.runs.map(inputTokens)),
    costUsd: sum(g.runs.map((r) => r.costUsd)),
  }
}

/** Batches of one job, or a lone batch when it has no job. */
export interface JobGroup {
  /** The job id, else the batch id. */
  key: string
  label: string | null
  /** Stages in start order. */
  batches: BatchGroup[]
}

const byStart = (a: BatchGroup, b: BatchGroup): number =>
  a.startedAt - b.startedAt || (a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0)

/**
 * A label followed by the context slug (last address segment), unless
 * the label already names it. No context leaves the label as is.
 */
export function withContext(label: string | null, context: string | null): string | null {
  const slug = context?.split("/").filter(Boolean).pop()
  if (!slug) return label
  if (!label) return slug
  return label.includes(slug) ? label : `${label} · ${slug}`
}

/**
 * Group batches into jobs. Jobs are ordered newest first by when their
 * first batch started, so a job keeps its place as later stages start;
 * stages within a job run in start order.
 */
export function groupJobs(rows: RunRow[]): JobGroup[] {
  const jobs = new Map<string, JobGroup>()
  for (const g of groupBatches(rows)) {
    const r = g.runs[0]!
    const key = r.jobId ?? g.batchId
    let j = jobs.get(key)
    if (!j) {
      const ctx = g.runs.find((x) => x.context)?.context ?? null
      j = { key, label: withContext(r.jobId ? (r.jobLabel ?? r.jobId) : g.label, ctx), batches: [] }
      jobs.set(key, j)
    }
    j.batches.push(g)
  }
  const out = [...jobs.values()]
  for (const j of out) j.batches.sort(byStart)
  return out.sort((a, b) => byStart(b.batches[0]!, a.batches[0]!))
}

/** State of a job: live while any stage is, crashed if any stage crashed. */
export function jobState(j: JobGroup): BatchState {
  const states = j.batches.map((b) => b.state)
  for (const s of ["running", "finalizing", "crashed"] as const) if (states.includes(s)) return s
  return "finished"
}

/** Totals of a job; time spans first stage start to last stage end. */
export function jobTotals(j: JobGroup): BatchTotals {
  const ts = j.batches.map(batchTotals)
  const ends = j.batches.map((b, i) => b.startedAt + (ts[i]!.elapsedSecs ?? 0))
  return {
    done: ts.reduce((a, t) => a + t.done, 0),
    total: ts.reduce((a, t) => a + t.total, 0),
    elapsedSecs: ts.some((t) => t.elapsedSecs !== null) ? Math.max(...ends) - j.batches[0]!.startedAt : null,
    tokensInput: sum(ts.map((t) => t.tokensInput)),
    costUsd: sum(ts.map((t) => t.costUsd)),
  }
}

/**
 * How a stage reads under its job: the part of the batch label after the
 * job id when the label embeds it, else the label, else the batch id.
 */
export function stageLabel(b: BatchGroup, jobId: string): string {
  const l = b.label ?? b.batchId
  const i = l.indexOf(jobId)
  if (i < 0) return l
  const rest = l.slice(i + jobId.length).replace(/^[-_.\s]+/, "")
  return rest || l
}

/** One run as the monitor lists it, with the label its line shows. */
export interface DisplayRun {
  row: RunRow
  label: string
}

/**
 * A block of the monitor list: a job, or a standalone batch, shown as a
 * foldable heading over a flat list of its runs in stage order.
 */
export interface DisplayGroup {
  key: string
  label: string
  state: BatchState
  totals: BatchTotals
  runs: DisplayRun[]
}

export function displayGroups(rows: RunRow[]): DisplayGroup[] {
  return groupJobs(rows).map((j) => {
    const isJob = j.batches[0]!.runs[0]!.jobId !== null
    const runs = j.batches.flatMap((b) => {
      const stage = isJob ? stageLabel(b, j.key) : (b.label ?? b.batchId)
      return b.runs.map((row) => ({ row, label: row.label ?? stage }))
    })
    return {
      key: j.key,
      label: j.label ?? j.key,
      state: jobState(j),
      totals: jobTotals(j),
      runs,
    }
  })
}

/** receipt.json of a finished run; only fields the stats pane shows. */
export interface RunReceipt {
  agent: string | null
  harness: string | null
  model: string | null
  outcome: string | null
  exitCode: number | null
  signal: string | null
  durationMs: number | null
  turns: number | null
  tokensInput: number | null
  tokensOutput: number | null
  costUsd: number | null
  error: string | null
  stderrExcerpt: string | null
  eventsMalformed: number | null
  eventsOversized: number | null
  eventsTruncated: boolean
  persistenceErrors: string[]
  cleanupErrors: string[]
}

/** Parse a run's receipt.json; undefined when unreadable or not JSON. */
export function parseReceipt(json: string): RunReceipt | undefined {
  let d: unknown
  try {
    d = JSON.parse(json)
  } catch {
    return undefined
  }
  if (typeof d !== "object" || d === null) return undefined
  const r = d as Record<string, unknown>
  const errList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []
  return {
    agent: str(r.agent),
    harness: str(r.harness),
    model: str(r.model),
    outcome: str(r.outcome),
    exitCode: num(r.exit_code),
    signal: str(r.signal),
    durationMs: num(r.duration_ms),
    turns: num(r.turns),
    tokensInput: num(r.tokens_input),
    tokensOutput: num(r.tokens_output),
    costUsd: num(r.cost_usd),
    error: str(r.error),
    stderrExcerpt: str(r.stderr_excerpt),
    eventsMalformed: num(r.events_malformed),
    eventsOversized: num(r.events_oversized),
    eventsTruncated: r.events_truncated === true,
    persistenceErrors: errList(r.persistence_errors),
    cleanupErrors: errList(r.cleanup_errors),
  }
}

/**
 * The stats pane's markdown: the receipt's post-run record with the ps
 * row's cache split. The response text and run_path stay out; the
 * response has its own pane and ctrl+y copies the dir.
 */
/**
 * The stats pane's yaml body: the receipt's post-run record with the ps
 * row's cache split, fenced so the markdown renderer highlights it.
 * The response text and run_path stay out; the response has its own
 * pane and ctrl+y copies the dir.
 */
export function receiptStats(rec: RunReceipt, r: RunRow): string {
  const lines: string[] = []
  const agent = [rec.agent, rec.harness].filter(Boolean).join(" / ")
  const kv = (k: string, v: string) => lines.push(`${k}: ${v}`)
  kv("agent", agent || r.agent)
  kv("model", rec.model ?? r.model)
  const exit = [
    rec.exitCode !== null ? `exit ${rec.exitCode}` : undefined,
    rec.signal ?? undefined,
  ].filter(Boolean).join(", ")
  kv("outcome", `${rec.outcome ?? "?"}${exit ? ` (${exit})` : ""}`)
  if (rec.durationMs !== null) kv("duration", fmtDuration(Math.round(rec.durationMs / 1000)))
  if (rec.turns !== null) kv("turns", `${rec.turns}`)
  kv("tokens", `${fmtTokens(r.tokensInput ?? rec.tokensInput)} in / ` +
    `${fmtTokens(r.tokensCacheRead)} cache read / ` +
    `${fmtTokens(r.tokensCacheWrite)} cache write / ` +
    `${fmtTokens(r.tokensOutput ?? rec.tokensOutput)} out`)
  kv("cost", fmtCost(rec.costUsd ?? r.costUsd))
  const events = [
    rec.eventsMalformed ? `${rec.eventsMalformed} malformed` : undefined,
    rec.eventsOversized ? `${rec.eventsOversized} oversized` : undefined,
    rec.eventsTruncated ? "truncated" : undefined,
  ].filter(Boolean)
  if (events.length) kv("events", events.join(", "))
  if (rec.error) kv("error", rec.error.replace(/\s+/g, " "))
  if (rec.stderrExcerpt) kv("stderr", rec.stderrExcerpt.replace(/\s+/g, " "))
  for (const [what, errs] of [["persistence", rec.persistenceErrors], ["cleanup", rec.cleanupErrors]] as const) {
    for (const e of errs) kv(`${what}_errors`, e.replace(/\s+/g, " "))
  }
  return lines.join("\n")
}
