import type { Theme } from "@earendil-works/pi-coding-agent"
import { type Component, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui"
import type { AgentState, RegistryRow } from "./events"
import { type ActivityItem, formatActivity, formatRow, visibleRows } from "./monitor-model"
import type { MonitorSource, MonitorSourceOptions } from "./monitor-source"

export const TICK_MS = 1000

/** Opens the data source; the view supplies the change and error callbacks. */
export type OpenSource = (callbacks: Pick<MonitorSourceOptions, "onChange" | "onError">) => Promise<MonitorSource>

const STATE_COLOR: Record<AgentState, "warning" | "accent" | "error" | "muted"> = {
  busy: "warning",
  "waiting-input": "accent",
  error: "error",
  idle: "muted",
}

const pad = (s: string, w: number): string => truncateToWidth(s, w, "~", true)

/** Full-screen live agent monitor fed by NATS: session list on top, detail below. */
export class AgentMonitorView implements Component {
  private source: MonitorSource | undefined
  private error = ""
  private connecting = true
  private showAll = false
  private selectedSid: string | undefined
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

  private rows(): RegistryRow[] {
    if (!this.source) return []
    return visibleRows(this.source.rows(), { showAll: this.showAll, now: this.now() })
  }

  private selectedIndex(rows: RegistryRow[]): number {
    const i = rows.findIndex((r) => r.sid === this.selectedSid)
    return i >= 0 ? i : 0
  }

  private syncSelection(rows: RegistryRow[]): RegistryRow | undefined {
    const row = rows[this.selectedIndex(rows)]
    this.selectedSid = row?.sid
    this.source?.select(row?.sid)
    return row
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") return this.close()
    if (data === "a") {
      this.showAll = !this.showAll
      return this.tui.requestRender()
    }
    const delta = matchesKey(data, "up") || data === "k" ? -1 : matchesKey(data, "down") || data === "j" ? 1 : 0
    if (delta === 0) return
    const rows = this.rows()
    if (rows.length === 0) return
    const i = Math.max(0, Math.min(rows.length - 1, this.selectedIndex(rows) + delta))
    this.selectedSid = rows[i]!.sid
    this.tui.requestRender()
  }

  invalidate(): void {}

  render(width: number): string[] {
    const t = this.theme
    const height = Math.max(10, this.tui.terminal.rows)
    const rows = this.rows()
    const selected = this.syncSelection(rows)
    const body = height - 4
    const listH = Math.max(3, Math.min(rows.length || 1, Math.floor(body * 0.4)))
    const lines = [
      this.headerLine(rows.length),
      t.fg("dim", ["up/down j/k select", `a ${this.showAll ? "delegated only" : "show all"}`, "q/esc close"].join(" | ")),
      t.fg("border", "-".repeat(width)),
      ...this.listLines(rows, width, listH),
      t.fg("border", "-".repeat(width)),
      ...this.detailLines(selected, width, body - listH - 1),
    ]
    while (lines.length < height - 1) lines.push("")
    lines.length = height - 1
    lines.push(this.error ? t.fg("error", this.error) : t.fg("muted", this.source?.url ?? ""))
    return lines.map((l) => truncateToWidth(l ?? "", width))
  }

  private headerLine(count: number): string {
    const t = this.theme
    const filter = this.showAll ? "all sessions" : "delegated runs"
    return `${t.fg("accent", t.bold("agents (nats)"))}  ${t.fg("muted", `${count} ${filter}`)}`
  }

  private listLines(rows: RegistryRow[], width: number, height: number): string[] {
    const t = this.theme
    const out: string[] = []
    if (this.connecting) out.push(t.fg("dim", "connecting..."))
    else if (!this.source) out.push(t.fg("error", "not connected"))
    else if (rows.length === 0) out.push(t.fg("dim", this.showAll ? "no live sessions" : "no delegated runs (a: show all)"))
    else {
      const sel = this.selectedIndex(rows)
      const now = this.now()
      const start = Math.max(0, Math.min(sel - Math.floor(height / 2), rows.length - height))
      for (const [i, row] of rows.slice(start, start + height).entries()) {
        const line = pad(formatRow(row, now), width)
        out.push(start + i === sel ? t.bg("selectedBg", line) : t.fg(STATE_COLOR[row.state] ?? "muted", line))
      }
    }
    while (out.length < height) out.push("")
    return out
  }

  private detailLines(row: RegistryRow | undefined, width: number, height: number): string[] {
    const t = this.theme
    if (!row || height <= 0) return []
    const field = (label: string, value: string | number | undefined) =>
      `${t.fg("muted", label.padEnd(9))}${value === undefined || value === "" ? t.fg("dim", "-") : String(value)}`
    const state = row.error ? `${row.state}: ${row.error}` : row.state
    const head = [
      field("sid", row.sid),
      field("run_id", row.run_id),
      field("cwd", row.cwd),
      field("context", row.context),
      field("model", row.model),
      field("session", row.session_file),
      `${t.fg("muted", "state".padEnd(9))}${t.fg(STATE_COLOR[row.state] ?? "muted", state)}`,
      t.fg("border", "-".repeat(width)),
    ]
    const room = Math.max(0, height - head.length)
    const items = this.source?.activity().items ?? []
    const activity = items.length === 0 ? [t.fg("dim", "no activity yet")] : items.slice(-room).map((i) => this.activityLine(i))
    return [...head, ...activity].slice(0, height)
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
