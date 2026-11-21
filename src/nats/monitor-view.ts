import type { Theme } from "@earendil-works/pi-coding-agent"
import { type Component, matchesKey, type TUI, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import {
  type ActivityItem,
  type Batch,
  formatActivity,
  formatAge,
  formatCost,
  formatRun,
  groupRuns,
  runCost,
  runModel,
  runStartedAt,
  type RunStatus,
  type RunView,
  runTurns,
  runViews,
} from "./monitor-model"
import type { MonitorSource, MonitorSourceOptions } from "./monitor-source"

export const TICK_MS = 1000

/** Opens the data source; the view supplies the change and error callbacks. */
export type OpenSource = (callbacks: Pick<MonitorSourceOptions, "onChange" | "onError">) => Promise<MonitorSource>

type Color = "warning" | "error" | "muted" | "success" | "dim"

const STATUS_COLOR: Record<RunStatus, Color> = {
  busy: "warning",
  idle: "muted",
  error: "error",
  done: "success",
  failed: "error",
  aborted: "warning",
  lost: "dim",
}

/** A selectable list line: a batch heading or one run. */
type Entry = { kind: "batch"; id: string; batch: Batch } | { kind: "run"; id: string; batch: Batch; run: RunView }

const batchKey = (batch: string): string => `batch:${batch}`

const pad = (s: string, w: number): string => truncateToWidth(s, w, "~", true)

/** Full-screen agent monitor fed by NATS: headless runs grouped by batch, preview below. */
export class AgentMonitorView implements Component {
  private source: MonitorSource | undefined
  private error = ""
  private connecting = true
  private running = true
  private preview = true
  private expandInputs = false
  /** Preview lines scrolled up from the tail; 0 follows new activity. */
  private previewScroll = 0
  private selectedId: string | undefined
  private foldOverride = new Map<string, boolean>()
  private timer: ReturnType<typeof setInterval> | undefined
  private closed = false

  constructor(
    private tui: TUI,
    private theme: Theme,
    open: OpenSource,
    private done: () => void,
    private now: () => number = Date.now,
  ) {
    this.timer = setInterval(() => this.tui.requestRender(), TICK_MS)
    open({
      onChange: () => this.tui.requestRender(),
      onError: (message) => {
        this.error = message
        this.tui.requestRender()
      },
    }).then(
      (source) => {
        this.connecting = false
        if (this.closed) {
          void source.close()
          return
        }
        this.source = source
        this.tui.requestRender()
      },
      (err) => {
        this.connecting = false
        this.error = err instanceof Error ? err.message : String(err)
        this.tui.requestRender()
      },
    )
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    void this.source?.close()
    this.done()
  }

  private views(): RunView[] {
    if (!this.source?.registryReady()) return []
    return runViews(this.source.history(), this.source.rows(), this.now())
  }

  private isFolded(b: Batch): boolean {
    return this.foldOverride.get(b.batch) ?? !b.runs.some((r) => r.live)
  }

  private entries(batches: Batch[]): Entry[] {
    const out: Entry[] = []
    for (const batch of batches) {
      out.push({ kind: "batch", id: batchKey(batch.batch), batch })
      if (!this.isFolded(batch)) for (const run of batch.runs) out.push({ kind: "run", id: run.id.runId, batch, run })
    }
    return out
  }

  /** Index of the selected entry; a run hidden by a fold resolves to its batch heading. */
  private selectedIndex(entries: Entry[]): number {
    let i = entries.findIndex((e) => e.id === this.selectedId)
    if (i < 0) i = entries.findIndex((e) => e.kind === "batch" && e.batch.runs.some((r) => r.id.runId === this.selectedId))
    return Math.max(0, i)
  }

  private selectedRun(entry: Entry | undefined): RunView | undefined {
    if (!entry) return undefined
    return entry.kind === "run" ? entry.run : entry.batch.runs[0]
  }

  private toggleFold(): void {
    const entries = this.entries(groupRuns(this.views(), this.running))
    const e = entries[this.selectedIndex(entries)]
    if (!e) return
    const fold = !this.isFolded(e.batch)
    this.foldOverride.set(e.batch.batch, fold)
    this.selectedId = batchKey(e.batch.batch)
    this.tui.requestRender()
  }

  private toggleFoldAll(): void {
    const batches = groupRuns(this.views(), this.running)
    const fold = batches.some((b) => !this.isFolded(b))
    for (const b of batches) this.foldOverride.set(b.batch, fold)
    this.tui.requestRender()
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") return this.close()
    if (matchesKey(data, "tab")) {
      this.running = !this.running
      return this.tui.requestRender()
    }
    if (matchesKey(data, "shift+tab")) return this.toggleFoldAll()
    if (matchesKey(data, "alt+z")) return this.toggleFold()
    if (matchesKey(data, "alt+p")) {
      this.preview = !this.preview
      return this.tui.requestRender()
    }
    if (matchesKey(data, "alt+e")) {
      this.expandInputs = !this.expandInputs
      this.previewScroll = 0
      return this.tui.requestRender()
    }
    if (matchesKey(data, "shift+up") || matchesKey(data, "shift+down")) {
      this.previewScroll = Math.max(0, this.previewScroll + (matchesKey(data, "shift+up") ? 1 : -1))
      return this.tui.requestRender()
    }
    const delta = matchesKey(data, "up") || data === "k" ? -1 : matchesKey(data, "down") || data === "j" ? 1 : 0
    if (delta === 0) return
    const entries = this.entries(groupRuns(this.views(), this.running))
    if (entries.length === 0) return
    const i = Math.max(0, Math.min(entries.length - 1, this.selectedIndex(entries) + delta))
    if (entries[i]!.id !== this.selectedId) this.previewScroll = 0
    this.selectedId = entries[i]!.id
    this.tui.requestRender()
  }

  invalidate(): void {}

  render(width: number): string[] {
    const t = this.theme
    const height = Math.max(10, this.tui.terminal.rows)
    const views = this.views()
    const entries = this.entries(groupRuns(views, this.running))
    const sel = this.selectedIndex(entries)
    const entry = entries[sel]
    if (entry) this.selectedId = entry.id
    const run = this.selectedRun(entry)
    this.source?.select(run?.id.runId)

    const body = height - 4
    const listH = this.preview ? Math.max(3, Math.floor(body * 0.4)) : body
    const keys = ["j/k select", `tab ${this.running ? "all" : "running"}`, "alt+z fold", "shift+tab fold all"]
    keys.push(
      `alt+p ${this.preview ? "hide" : "show"} preview`,
      `alt+e ${this.expandInputs ? "collapse" : "expand"} prompts`,
      "shift+up/down scroll",
      "q/esc close",
    )
    const lines = [
      this.headerLine(views),
      t.fg("dim", keys.join(" | ")),
      t.fg("border", "-".repeat(width)),
      ...this.listLines(entries, sel, width, listH),
    ]
    if (this.preview) lines.push(t.fg("border", "-".repeat(width)), ...this.previewLines(run, width, body - listH - 1))
    while (lines.length < height - 1) lines.push("")
    lines.length = height - 1
    lines.push(this.error ? t.fg("error", this.error) : t.fg("muted", this.source?.url ?? ""))
    return lines.map((l) => truncateToWidth(l ?? "", width))
  }

  private headerLine(views: RunView[]): string {
    const t = this.theme
    const live = views.filter((v) => v.live).length
    const view = this.running ? "running" : "all runs (7d)"
    return `${t.fg("accent", t.bold("agents (nats)"))}  ${t.bold(view)}  ${t.fg("muted", `${live} live / ${views.length} total`)}`
  }

  private listLines(entries: Entry[], sel: number, width: number, height: number): string[] {
    const t = this.theme
    const out: string[] = []
    if (this.connecting) out.push(t.fg("dim", "connecting..."))
    else if (!this.source) out.push(t.fg("error", "not connected"))
    else if (!this.source.registryReady()) out.push(t.fg("dim", "loading..."))
    else if (entries.length === 0) out.push(t.fg("dim", this.running ? "no running runs (tab: all runs)" : "no runs in the last 7 days"))
    else {
      const now = this.now()
      const start = Math.max(0, Math.min(sel - Math.floor(height / 2), entries.length - height))
      for (const [i, e] of entries.slice(start, start + height).entries()) {
        const selected = start + i === sel
        if (e.kind === "batch") {
          const line = pad(this.batchLine(e.batch), width)
          out.push(selected ? t.bg("selectedBg", line) : t.fg("accent", line))
        } else {
          const line = pad(`    ${formatRun(e.run, now)}`, width)
          out.push(selected ? t.bg("selectedBg", line) : t.fg(STATUS_COLOR[e.run.status], line))
        }
      }
    }
    while (out.length < height) out.push("")
    return out
  }

  private batchLine(b: Batch): string {
    const live = b.runs.filter((r) => r.live).length
    const counts = new Map<string, number>()
    for (const r of b.runs) counts.set(r.status, (counts.get(r.status) ?? 0) + 1)
    const summary = [...counts.entries()].map(([s, n]) => `${n} ${s}`).join(", ")
    const agents = [...new Set(b.runs.map((r) => r.id.agent))].join(",")
    return `${this.isFolded(b) ? "+" : "-"} ${b.batch}  ${agents}  ${b.runs.length} runs${live ? `, ${live} live` : ""}  (${summary})`
  }

  private previewLines(run: RunView | undefined, width: number, height: number): string[] {
    const t = this.theme
    if (!run || height <= 0) return []
    const field = (label: string, value: string | number | undefined) =>
      `${t.fg("muted", label.padEnd(9))}${value === undefined || value === "" ? t.fg("dim", "-") : String(value)}`
    const row = run.row
    const rec = run.record
    const outcome = row?.error ? `${run.status}: ${row.error}` : rec?.lastError && !run.live ? `${run.status}: ${rec.lastError}` : run.status
    const started = runStartedAt(run)
    const turns = runTurns(run)
    const elapsed = started === undefined ? undefined : formatAge((rec?.ended && !run.live ? rec.endedAt! : this.now()) - started)
    const head = [
      field("run", run.id.runId),
      `${t.fg("muted", "status".padEnd(9))}${t.fg(STATUS_COLOR[run.status], outcome)}`,
      field("cwd", row?.cwd ?? rec?.cwd),
      field("context", row?.context ?? rec?.context),
      field("model", runModel(run)),
      field("cost", `${formatCost(runCost(run))}${turns === undefined ? "" : `  ${turns} turns`}${elapsed ? `  ${elapsed}` : ""}`),
      t.fg("border", "-".repeat(width)),
    ]
    const room = Math.max(0, height - head.length)
    const items = this.source?.activity().items ?? []
    if (items.length === 0) return [...head, t.fg("dim", "no activity")].slice(0, height)
    const activity = items.flatMap((i) => this.activityLines(i, width))
    const max = Math.max(0, activity.length - room)
    this.previewScroll = Math.min(this.previewScroll, max)
    const end = activity.length - this.previewScroll
    return [...head, ...activity.slice(Math.max(0, end - room), end)].slice(0, height)
  }

  private activityLines(item: ActivityItem, width: number): string[] {
    if (item.kind !== "input" || !this.expandInputs) return [this.activityLine(item)]
    const t = this.theme
    const body = item.text ?? item.preview
    return [
      t.fg("accent", `> [${item.source || "input"}]`),
      ...body.split("\n").flatMap((l) => wrapTextWithAnsi(`  ${l}`, Math.max(10, width))),
    ]
  }

  private activityLine(item: ActivityItem): string {
    const t = this.theme
    const text = formatActivity(item)
    switch (item.kind) {
      case "tool":
        return t.fg(item.status === "error" ? "error" : item.status === "ok" ? "success" : "warning", text.slice(0, 3)) + text.slice(3)
      case "input":
        return t.fg("accent", text)
      case "thinking":
        return t.fg("dim", text)
      case "error":
        return t.fg("error", text)
      default:
        return t.fg("muted", text)
    }
  }
}
