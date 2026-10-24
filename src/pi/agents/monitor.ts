/**
 * Full-screen cue-agent monitor: one row per run from `cue-agent ps --all`,
 * with the run's prompt or response beside it. Polls while open.
 *
 * Independent of the cue browser on purpose; data access arrives through
 * MonitorDeps and this module only renders and dispatches keys.
 */

import { dirname } from "node:path"
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
  type DisplayGroup,
  displayGroups,
  fmtCost,
  fmtDuration,
  fmtTokens,
  inputTokens,
  haystack,
  isLive,
  type RunRow,
  runState,
  stateTone,
} from "./model"

export const POLL_MS = 5000

export interface MonitorDeps {
  /** Every run cue-agent knows, newest batch first; error text on failure. */
  load(): Promise<{ rows: RunRow[] } | { error: string }>
  /** The run's prompt.md, if readable. */
  prompt(runPath: string): string | undefined
  /** File holding the document shown in a pane; undefined if none. */
  documentPath(r: RunRow, pane: "prompt" | "response"): string | undefined
  /** Suspend pi and edit a file in $EDITOR; resolves when it exits. */
  editFile(path: string): Promise<void>
  /** Copy text to the system clipboard. */
  copy(text: string): Promise<void>
  /** Open a file in a new tmux window; error text on failure. */
  openInTmux(path: string): string | undefined
}

export type Target = "here" | "tmux"

type Subset = "running" | "all"
type Pane = "prompt" | "response"

/** A selectable list line: a run, or the heading of a folded group. */
interface Entry {
  id: string
  group: DisplayGroup
  /** The run shown in the preview: the run itself, or a folded group's first. */
  row: RunRow
  folded: boolean
}

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
  /** Groups the operator folded or unfolded; others follow isFolded's default. */
  private foldOverride = new Map<string, boolean>()

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
   * Runs to list in display order: jobs, stages, runs. The running subset
   * keeps whole jobs that still have a live run; the query keeps matching
   * runs.
   */
  private groups(): DisplayGroup[] {
    const jobOf = (r: RunRow) => r.jobId ?? r.batchId
    let base = this.rows
    if (this.subset === "running") {
      const live = new Set(this.rows.filter(isLive).map(jobOf))
      base = base.filter((r) => live.has(jobOf(r)))
    }
    const q = this.input.getValue().trim()
    if (q) {
      const hit = new Set(fuzzyFilter(base, q, (r) => haystack(r)).map((r) => r.runId))
      base = base.filter((r) => hit.has(r.runId))
    }
    return displayGroups(base)
  }

  /** Selectable lines in display order, so moving walks the list top to bottom. */
  private shown(): Entry[] {
    return this.groups().flatMap((group): Entry[] =>
      this.isFolded(group)
        ? [{ id: `group:${group.key}`, group, row: group.runs[0]!.row, folded: true }]
        : group.runs.map((r) => ({ id: r.row.runId, group, row: r.row, folded: false })),
    )
  }

  /** Index of the selected entry, following it across refreshes and folds. */
  private selectedIndex(entries: Entry[]): number {
    let i = entries.findIndex((e) => e.id === this.selectedId)
    if (i < 0) i = entries.findIndex((e) => e.folded && e.group.runs.some((r) => r.row.runId === this.selectedId))
    if (i < 0) i = entries.findIndex((e) => this.selectedId === `group:${e.group.key}`)
    return i >= 0 ? i : 0
  }

  private selectedEntry(): Entry | undefined {
    const entries = this.shown()
    return entries[this.selectedIndex(entries)]
  }

  private selected(): RunRow | undefined {
    return this.selectedEntry()?.row
  }

  /** Groups start folded unless a run in them is still live. */
  private isFolded(g: DisplayGroup): boolean {
    return this.foldOverride.get(g.key) ?? !g.runs.some((r) => isLive(r.row))
  }

  private toggleFold(): void {
    const e = this.selectedEntry()
    if (!e) return
    const fold = !this.isFolded(e.group)
    this.foldOverride.set(e.group.key, fold)
    this.selectedId = fold ? `group:${e.group.key}` : e.group.runs[0]!.row.runId
    this.previewScroll = 0
    this.tui.requestRender()
  }

  // ---- input -----------------------------------------------------------

  handleInput(data: string): void {
    if (this.busy) return
    const rows = this.shown()
    const move = (delta: number) => {
      if (rows.length === 0) return
      const i = Math.max(0, Math.min(rows.length - 1, this.selectedIndex(rows) + delta))
      this.selectedId = rows[i]!.id
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
    if (matchesKey(data, "alt+z")) return this.toggleFold()
    if (matchesKey(data, "ctrl+h")) return void this.onCopy("id")
    if (matchesKey(data, "ctrl+y")) return void this.onCopy("path")
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

  /**
   * Copy the selected run's id or directory; on a folded heading, the job
   * id (else batch id) or the batch directory holding its runs.
   */
  private async onCopy(what: "id" | "path"): Promise<void> {
    const e = this.selectedEntry()
    if (!e) return
    const r = e.row
    const text = what === "id"
      ? (e.folded ? (r.jobId ?? r.batchId) : r.runId)
      : (e.folded ? dirname(r.runPath) : r.runPath)
    if (!text) return
    try {
      await this.deps.copy(text)
      this.status = `copied ${text}`
    } catch (err) {
      this.status = `copy failed: ${err instanceof Error ? err.message : String(err)}`
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
      "alt+z fold",
      "ctrl+h id",
      "ctrl+y dir",
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
    const entries = this.shown()
    if (entries.length === 0) {
      return [t.fg("warning", this.subset === "running" ? "no live runs (tab: all)" : "no runs")]
    }
    this.selectedId = entries[this.selectedIndex(entries)]!.id
    const toneColor = { live: "warning", ok: "success", bad: "error", dim: "dim" } as const
    // Fixed columns on the right, shared by headings and run lines.
    const nums = (secs: number | null, tokens: number | null, cost: number | null) =>
      `${fmtDuration(secs).padStart(6)} ${fmtTokens(tokens).padStart(6)} ${fmtCost(cost).padStart(7)}`
    const rightW = 6 + 1 + 6 + 1 + 7
    const stateW = 10
    const agentW = 10
    const modelW = 22
    const indentW = 2
    // The label column fits its content so figures sit next to it.
    const fixedW = indentW + stateW + agentW + modelW + rightW + 4
    const groups = this.groups()
    const longest = Math.max(6, ...groups.flatMap((g) => g.runs.map((r) => r.label.length)))
    const labelW = Math.max(6, Math.min(width - fixedW, longest))
    const rowW = fixedW + labelW
    const leftW = rowW - rightW - 1

    const lines: string[] = []
    let selLine = 0
    const push = (id: string, line: string) => {
      if (id === this.selectedId) {
        selLine = lines.length
        lines.push(t.bg("selectedBg", line))
      } else lines.push(line)
    }
    // Heading: fold marker, state, label, done count; totals in the shared columns.
    const heading = (g: DisplayGroup, folded: boolean) => {
      const n = g.totals
      const state = g.state
      const head = [
        t.fg("dim", folded ? "▸" : "▾"),
        t.fg(toneColor[stateTone(state)], pad(state, stateW)),
        t.fg("accent", t.bold(g.label)),
        t.fg("muted", `${n.done}/${n.total}`),
      ].join(" ")
      return pad(head, leftW) + " " + t.fg("muted", nums(n.elapsedSecs, n.tokensInput, n.costUsd))
    }
    const runLine = (indent: string, r: RunRow, label: string) => {
      const state = runState(r)
      return pad(
        indent + [
          t.fg(toneColor[stateTone(state)], pad(state, stateW)),
          pad(r.agent, agentW),
          t.fg("muted", pad(r.model.replace(/^[^/]+\//, ""), modelW)),
          pad(label, labelW + indentW - indent.length),
          t.fg("muted", nums(r.elapsedSecs, inputTokens(r), r.costUsd)),
        ].join(" "),
        rowW,
      )
    }
    for (const g of groups) {
      const folded = this.isFolded(g)
      push(`group:${g.key}`, heading(g, folded))
      if (folded) continue
      for (const r of g.runs) push(r.row.runId, runLine("  ", r.row, r.label))
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
