/**
 * Full-screen cue-agent monitor: one row per run from `cue-agent ps --all`,
 * with the run's prompt or response beside it. Polls while open.
 *
 * Independent of the cue browser on purpose; data access arrives through
 * MonitorDeps and this module only renders and dispatches keys.
 */

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent"
import {
  type Component,
  fuzzyFilter,
  Input,
  Markdown,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui"
import {
  batchTotals,
  fmtCost,
  fmtDuration,
  fmtTokens,
  groupBatches,
  haystack,
  isLive,
  type RunManifest,
  type RunRow,
  runState,
  stateTone,
} from "./model"

export const POLL_MS = 5000

export interface MonitorDeps {
  /** Every run cue-agent knows, newest batch first; error text on failure. */
  load(): Promise<{ rows: RunRow[] } | { error: string }>
  /** Label and context of a run; manifests never change, so callers cache. */
  manifest(runPath: string): RunManifest | undefined
  /** The run's prompt.md, if readable. */
  prompt(runPath: string): string | undefined
  /** File holding the document shown in a pane; undefined if none. */
  documentPath(r: RunRow, pane: "prompt" | "response"): string | undefined
  /** Suspend pi and edit a file in $EDITOR; resolves when it exits. */
  editFile(path: string): Promise<void>
  /** Open a file in a new tmux window; error text on failure. */
  openInTmux(path: string): string | undefined
}

export type Target = "here" | "tmux"

type Subset = "running" | "all"
type Pane = "prompt" | "response"

const pad = (s: string, w: number): string => truncateToWidth(s, w, "…", true)

export class AgentMonitor implements Component {
  private input = new Input()
  private rows: RunRow[] = []
  private loaded = false
  private loading = false
  private error = ""
  private subset: Subset = "running"
  private pane: Pane = "prompt"
  private stacked = false
  private preview = true
  private selectedId: string | undefined
  private previewScroll = 0
  private previewCache: { key: string; lines: string[] } | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private target: Target = "tmux"
  private status = ""
  private busy = false

  constructor(
    private tui: TUI,
    private theme: Theme,
    private kb: KeybindingsManager,
    private deps: MonitorDeps,
    private done: () => void,
  ) {
    this.input.focused = true
    void this.reload(true)
    this.timer = setInterval(() => void this.reload(false), POLL_MS)
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.done()
  }

  private async reload(first: boolean): Promise<void> {
    if (this.loading) return
    this.loading = true
    const r = await this.deps.load()
    this.loading = false
    if (!this.timer && !first) return
    if ("error" in r) {
      this.error = r.error
    } else {
      this.error = ""
      this.rows = r.rows
      if (first && !r.rows.some(isLive)) this.subset = "all"
    }
    this.loaded = true
    // The selected run's response may have just arrived.
    this.previewCache = undefined
    this.tui.requestRender()
  }

  /**
   * Runs to list, always in ps order (newest batch first, runs by
   * position) so batches never interleave. The running subset keeps whole
   * batches that still have a live run; the query keeps matching runs.
   */
  private shown(): RunRow[] {
    let base = this.rows
    if (this.subset === "running") {
      const live = new Set(this.rows.filter(isLive).map((r) => r.batchId))
      base = base.filter((r) => live.has(r.batchId))
    }
    const q = this.input.getValue().trim()
    if (!q) return base
    const hit = new Set(fuzzyFilter(base, q, (r) => haystack(r, this.deps.manifest(r.runPath))).map((r) => r.runId))
    return base.filter((r) => hit.has(r.runId))
  }

  /** Index of the selected run in `rows`, following it across refreshes. */
  private selectedIndex(rows: RunRow[]): number {
    const i = rows.findIndex((r) => r.runId === this.selectedId)
    return i >= 0 ? i : 0
  }

  private selected(): RunRow | undefined {
    const rows = this.shown()
    return rows[this.selectedIndex(rows)]
  }

  // ---- input -----------------------------------------------------------

  handleInput(data: string): void {
    if (this.busy) return
    const rows = this.shown()
    const move = (delta: number) => {
      if (rows.length === 0) return
      const i = Math.max(0, Math.min(rows.length - 1, this.selectedIndex(rows) + delta))
      this.selectedId = rows[i]!.runId
      this.previewScroll = 0
      this.tui.requestRender()
    }
    const page = Math.max(1, this.bodyHeight() - 1)

    if (matchesKey(data, "escape")) return this.close()
    if (this.kb.matches(data, "tui.select.up")) return move(-1)
    if (this.kb.matches(data, "tui.select.down")) return move(1)
    if (this.kb.matches(data, "tui.select.pageUp")) return move(-page)
    if (this.kb.matches(data, "tui.select.pageDown")) return move(page)
    if (matchesKey(data, "tab")) {
      this.subset = this.subset === "running" ? "all" : "running"
      this.previewScroll = 0
      return this.tui.requestRender()
    }
    if (matchesKey(data, "ctrl+r")) return void this.reload(false)
    if (matchesKey(data, "enter")) return void this.onOpen()
    if (matchesKey(data, "ctrl+t")) {
      this.target = this.target === "here" ? "tmux" : "here"
      return this.tui.requestRender()
    }
    if (matchesKey(data, "alt+r")) {
      this.pane = this.pane === "prompt" ? "response" : "prompt"
      this.previewScroll = 0
      return this.tui.requestRender()
    }
    if (matchesKey(data, "alt+p")) {
      this.preview = !this.preview
      return this.tui.requestRender()
    }
    if (matchesKey(data, "alt+l")) {
      this.stacked = !this.stacked
      return this.tui.requestRender()
    }
    if (matchesKey(data, "ctrl+d")) return this.scrollPreview(Math.floor(page / 2))
    if (matchesKey(data, "ctrl+u")) return this.scrollPreview(-Math.floor(page / 2))

    const before = this.input.getValue()
    this.input.handleInput(data)
    if (this.input.getValue() !== before) {
      this.selectedId = undefined
      this.previewScroll = 0
      this.tui.requestRender()
    }
  }

  private async onOpen(): Promise<void> {
    const r = this.selected()
    if (!r) return
    const path = this.deps.documentPath(r, this.pane)
    if (!path) {
      this.status = `no ${this.pane} to open`
      return this.tui.requestRender()
    }
    if (this.target === "tmux") {
      this.status = this.deps.openInTmux(path) ?? `opened ${this.pane} of ${r.runId} in tmux`
      return this.tui.requestRender()
    }
    this.busy = true
    try {
      await this.deps.editFile(path)
    } finally {
      this.busy = false
    }
    this.tui.requestRender()
  }

  private scrollPreview(delta: number): void {
    this.previewScroll = Math.max(0, this.previewScroll + delta)
    this.tui.requestRender()
  }

  // ---- rendering -------------------------------------------------------

  private height(): number {
    return Math.max(8, this.tui.terminal.rows)
  }

  private bodyHeight(): number {
    return this.height() - 5
  }

  invalidate(): void {
    this.previewCache = undefined
    this.input.invalidate()
  }

  render(width: number): string[] {
    const t = this.theme
    const height = this.height()
    const body = this.bodyHeight()
    const lines = [
      this.headerLine(width),
      this.helpLine(width),
      this.input.render(width)[0] ?? "",
      t.fg("border", "─".repeat(width)),
      ...this.bodyLines(width, body),
    ]
    while (lines.length < height - 1) lines.push("")
    lines.push(this.error ? t.fg("error", `cue-agent: ${this.error}`) : t.fg("muted", this.status))
    return lines.slice(0, height).map((l) => truncateToWidth(l, width))
  }

  private headerLine(width: number): string {
    const t = this.theme
    const live = this.rows.filter(isLive).length
    const target = t.fg(this.target === "tmux" ? "warning" : "muted", `[${this.target}]`)
    const title = t.fg("accent", t.bold("cue-agent runs")) + "  " + target + " " +
      t.fg("muted", `(${this.subset}) ${live} live, ${this.rows.length} total`)
    return truncateToWidth(title, width)
  }

  private helpLine(width: number): string {
    const hints = [
      "tab running/all",
      `enter open ${this.pane}`,
      "ctrl+t target",
      `alt+r ${this.pane === "prompt" ? "response" : "prompt"}`,
      "ctrl+r refresh",
      `alt+p ${this.preview ? "hide" : "show"} preview`,
      "alt+l layout",
      "ctrl+d/u scroll",
      "esc close",
    ]
    return truncateToWidth(this.theme.fg("dim", hints.join(" • ")), width, "…")
  }

  private bodyLines(width: number, body: number): string[] {
    const t = this.theme
    const out: string[] = []
    if (!this.preview) {
      const list = this.listLines(width, body)
      for (let i = 0; i < body; i++) out.push(pad(list[i] ?? "", width))
      return out
    }
    if (this.stacked) {
      const listH = Math.max(3, Math.floor((body - 1) * 0.4))
      const list = this.listLines(width, listH)
      for (let i = 0; i < listH; i++) out.push(pad(list[i] ?? "", width))
      out.push(t.fg("border", "─".repeat(width)))
      out.push(...this.previewLines(width, body - listH - 1))
      return out
    }
    const listWidth = Math.max(40, Math.min(width - 30, Math.floor(width * 0.55)))
    const previewWidth = Math.max(10, width - listWidth - 3)
    const list = this.listLines(listWidth, body)
    const preview = this.previewLines(previewWidth, body)
    const sep = t.fg("border", " │ ")
    for (let i = 0; i < body; i++) {
      out.push(pad(list[i] ?? "", listWidth) + sep + pad(preview[i] ?? "", previewWidth))
    }
    return out
  }

  private listLines(width: number, height: number): string[] {
    const t = this.theme
    if (!this.loaded) return [t.fg("dim", "loading…")]
    const rows = this.shown()
    if (rows.length === 0) {
      return [t.fg("warning", this.subset === "running" ? "no live runs (tab: all)" : "no runs")]
    }
    const sel = this.selectedIndex(rows)
    this.selectedId = rows[sel]!.runId
    const toneColor = { live: "warning", ok: "success", bad: "error", dim: "dim" } as const
    // Fixed columns on the right, shared by batch and run lines.
    const nums = (secs: number | null, tokens: number | null, cost: number | null) =>
      `${fmtDuration(secs).padStart(6)} ${fmtTokens(tokens).padStart(6)} ${fmtCost(cost).padStart(7)}`
    const rightW = 6 + 1 + 6 + 1 + 7
    const stateW = 10
    const agentW = 10
    const modelW = 22
    const labelW = Math.max(6, width - 2 - stateW - agentW - modelW - rightW - 4)

    const lines: string[] = []
    let selLine = 0
    for (const g of groupBatches(rows)) {
      const tot = batchTotals(g)
      const head = `${g.label ?? g.batchId}  ${t.fg("muted", `${tot.done}/${tot.total} done`)}`
      const stateTxt = t.fg(toneColor[stateTone(g.state)], g.state)
      const leftW = width - rightW - 1
      lines.push(
        pad(t.bold(pad(head, Math.max(6, leftW - visibleWidth(g.state) - 1))) + " " + stateTxt, leftW) +
          " " + t.fg("muted", nums(tot.elapsedSecs, tot.tokensInput, tot.costUsd)),
      )
      for (const r of g.runs) {
        const state = runState(r)
        const line = pad(
          "  " +
            [
              t.fg(toneColor[stateTone(state)], pad(state, stateW)),
              pad(r.agent, agentW),
              t.fg("muted", pad(r.model.replace(/^[^/]+\//, ""), modelW)),
              pad(this.deps.manifest(r.runPath)?.label ?? "", labelW),
              t.fg("muted", nums(r.elapsedSecs, r.tokensInput, r.costUsd)),
            ].join(" "),
          width,
        )
        if (r.runId === this.selectedId) {
          selLine = lines.length
          lines.push(t.bg("selectedBg", line))
        } else lines.push(line)
      }
    }
    const start = Math.max(0, Math.min(selLine - Math.floor(height / 2), lines.length - height))
    return lines.slice(start, start + height)
  }

  private previewSource(r: RunRow): string {
    if (this.pane === "prompt") return this.deps.prompt(r.runPath) ?? "_no prompt.md_"
    if (r.error) return `**${r.outcome ?? "error"}:** ${r.error}\n\n${r.response ?? ""}`
    if (r.response) return r.response
    return isLive(r) ? "_still running_" : "_no response_"
  }

  private previewLines(width: number, height: number): string[] {
    const r = this.selected()
    if (!r) return []
    const key = `${r.runId}:${this.pane}:${width}`
    if (this.previewCache?.key !== key) {
      const lines = new Markdown(this.previewSource(r), 0, 0, getMarkdownTheme()).render(width)
      this.previewCache = { key, lines }
    }
    const t = this.theme
    const head = t.fg("muted", `${this.pane} • ${r.runId}`)
    const lines = this.previewCache.lines
    const max = Math.max(0, lines.length - (height - 1))
    this.previewScroll = Math.min(this.previewScroll, max)
    return [head, ...lines.slice(this.previewScroll, this.previewScroll + height - 1)]
  }
}
