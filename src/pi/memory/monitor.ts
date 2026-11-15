/**
 * Full-screen, read-only memory monitor with three tabs: Memory (levels
 * and files for the current cwd), Runs (reflection runs) and Commits
 * (memory repo history). Data arrives through a MemorySource; this module
 * only renders and dispatches keys.
 */

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import { getMarkdownTheme, highlightCode } from "@earendil-works/pi-coding-agent"
import { type Component, Markdown, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui"
import { fmtWhen } from "../browser/activity"
import {
  fmtDuration,
  type MemoryCommit,
  type MemoryLevel,
  memoryPreview,
  type MemoryRow,
  memoryRows,
  type MemorySource,
  type ReflectionRun,
  runDetail,
  runStatus,
  runTone,
  triggerText,
} from "./model"

export const POLL_MS = 5000

export type Tab = "memory" | "runs" | "commits"
const TABS: readonly Tab[] = ["memory", "runs", "commits"]

interface Row {
  id: string
  line: (width: number) => string
}

const pad = (s: string, w: number): string => truncateToWidth(s, w, "…", true)

export class MemoryMonitor implements Component {
  private tab: Tab = "memory"
  private levels: MemoryLevel[] = []
  private runs: ReflectionRun[] = []
  private commits: MemoryCommit[] = []
  private diffs = new Map<string, string | undefined>()
  private loaded = false
  private loading = false
  private error = ""
  private selected: Record<Tab, string | undefined> = { memory: undefined, runs: undefined, commits: undefined }
  private scroll = 0
  private stacked = true
  private previewCache: { key: string; lines: string[] } | undefined
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private tui: TUI,
    private theme: Theme,
    private kb: KeybindingsManager,
    private source: MemorySource,
    private cwd: string,
    private done: () => void,
  ) {
    void this.reload()
    this.timer = setInterval(() => void this.reload(), POLL_MS)
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.done()
  }

  private async reload(): Promise<void> {
    if (this.loading) return
    this.loading = true
    try {
      const [levels, runs, commits] = await Promise.all([
        this.source.levels(this.cwd),
        this.source.runs(),
        this.source.commits(),
      ])
      this.levels = levels
      this.runs = runs
      this.commits = commits
      this.error = ""
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
    } finally {
      this.loading = false
    }
    this.loaded = true
    this.previewCache = undefined
    this.tui.requestRender()
  }

  private async loadDiff(hash: string): Promise<void> {
    if (this.diffs.has(hash)) return
    this.diffs.set(hash, undefined)
    const text = await this.source.show(hash)
    this.diffs.set(hash, text ?? "")
    this.previewCache = undefined
    this.tui.requestRender()
  }

  // ---- rows --------------------------------------------------------------

  private rows(): Row[] {
    const t = this.theme
    if (this.tab === "memory") {
      return memoryRows(this.levels).map((r) => ({
        id: r.id,
        line: (w) => r.file
          ? pad(`  ${r.file.path.slice(r.level.path.length + 1)}`, w)
          : pad(`${t.fg("accent", t.bold(r.level.label))} ${t.fg("muted", r.level.path)}`, w),
      }))
    }
    const now = Date.now()
    if (this.tab === "runs") {
      const color = { live: "warning", ok: "success", bad: "error", dim: "dim" } as const
      return this.runs.map((r) => ({
        id: r.id,
        line: (w) => pad([
          t.fg(color[runTone(r)], pad(runStatus(r), 10)),
          t.fg("muted", pad(fmtWhen(r.started, now), 11)),
          t.fg("muted", fmtDuration(r.durationSecs).padStart(6)),
          triggerText(r.trigger),
        ].join(" "), w),
      }))
    }
    return this.commits.map((c) => ({
      id: c.hash,
      line: (w) => pad([
        t.fg("warning", c.hash.slice(0, 7)),
        t.fg("muted", pad(fmtWhen(c.time, now), 11)),
        c.subject,
      ].join(" "), w),
    }))
  }

  private selectedIndex(rows: Row[]): number {
    const i = rows.findIndex((r) => r.id === this.selected[this.tab])
    return i >= 0 ? i : 0
  }

  private selectedId(): string | undefined {
    const rows = this.rows()
    return rows[this.selectedIndex(rows)]?.id
  }

  // ---- input -------------------------------------------------------------

  handleInput(data: string): void {
    const rows = this.rows()
    const move = (delta: number) => {
      if (rows.length === 0) return
      const i = Math.max(0, Math.min(rows.length - 1, this.selectedIndex(rows) + delta))
      this.selected[this.tab] = rows[i]!.id
      this.scroll = 0
      this.tui.requestRender()
    }
    const page = Math.max(1, this.bodyHeight() - 1)
    const switchTab = (delta: number) => {
      this.tab = TABS[(TABS.indexOf(this.tab) + delta + TABS.length) % TABS.length]!
      this.scroll = 0
      this.tui.requestRender()
    }

    if (matchesKey(data, "escape")) return this.close()
    if (this.kb.matches(data, "tui.select.up")) return move(-1)
    if (this.kb.matches(data, "tui.select.down")) return move(1)
    if (this.kb.matches(data, "tui.select.pageUp")) return move(-page)
    if (this.kb.matches(data, "tui.select.pageDown")) return move(page)
    if (matchesKey(data, "tab")) return switchTab(1)
    if (matchesKey(data, "shift+tab")) return switchTab(-1)
    if (data === "1" || data === "2" || data === "3") {
      this.tab = TABS[Number(data) - 1]!
      this.scroll = 0
      return this.tui.requestRender()
    }
    if (matchesKey(data, "alt+r")) return void this.reload()
    if (matchesKey(data, "alt+l")) {
      this.stacked = !this.stacked
      return this.tui.requestRender()
    }
    if (matchesKey(data, "shift+down")) return this.scrollBy(Math.floor(page / 2))
    if (matchesKey(data, "shift+up")) return this.scrollBy(-Math.floor(page / 2))
  }

  private scrollBy(delta: number): void {
    this.scroll = Math.max(0, this.scroll + delta)
    this.tui.requestRender()
  }

  // ---- rendering ---------------------------------------------------------

  private height(): number {
    return Math.max(8, this.tui.terminal.rows)
  }

  private bodyHeight(): number {
    return this.height() - 4
  }

  invalidate(): void {
    this.previewCache = undefined
  }

  render(width: number): string[] {
    const t = this.theme
    const height = this.height()
    const lines = [
      this.headerLine(),
      this.helpLine(),
      t.fg("border", "─".repeat(width)),
      ...this.bodyLines(width, this.bodyHeight()),
    ]
    while (lines.length < height - 1) lines.push("")
    lines.push(this.error ? t.fg("error", `memory: ${this.error}`) : t.fg("muted", this.source.root))
    return lines.slice(0, height).map((l) => truncateToWidth(l, width))
  }

  private headerLine(): string {
    const t = this.theme
    const counts: Record<Tab, number> = {
      memory: this.levels.reduce((n, l) => n + l.files.length, 0),
      runs: this.runs.length,
      commits: this.commits.length,
    }
    const tabs = TABS.map((tab, i) => {
      const label = `${i + 1} ${tab} (${counts[tab]})`
      return tab === this.tab ? t.fg("accent", t.bold(`[${label}]`)) : t.fg("muted", ` ${label} `)
    })
    return `${t.fg("accent", t.bold("memory"))}  ${tabs.join(" ")}`
  }

  private helpLine(): string {
    const hints = ["tab/1-3 view", "alt+r refresh", "alt+l layout", "shift+up/down scroll", "esc close"]
    return this.theme.fg("dim", hints.join(" • "))
  }

  private bodyLines(width: number, body: number): string[] {
    const t = this.theme
    const out: string[] = []
    if (this.stacked) {
      const listH = Math.max(3, Math.floor((body - 1) * 0.4))
      const list = this.listLines(width, listH)
      for (let i = 0; i < listH; i++) out.push(pad(list[i] ?? "", width))
      out.push(t.fg("border", "─".repeat(width)))
      out.push(...this.previewLines(width, body - listH - 1))
      return out
    }
    const listWidth = Math.max(30, Math.floor(width * 0.4))
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
    const rows = this.rows()
    if (rows.length === 0) return [t.fg("warning", `no ${this.tab}`)]
    const sel = this.selectedIndex(rows)
    this.selected[this.tab] = rows[sel]!.id
    const lines = rows.map((r, i) => (i === sel ? t.bg("selectedBg", pad(r.line(width), width)) : r.line(width)))
    const start = Math.max(0, Math.min(sel - Math.floor(height / 2), lines.length - height))
    return lines.slice(start, start + height)
  }

  /** The preview's title, text, and a code language when not markdown. */
  private previewSource(id: string): { title: string; text: string; lang?: string } | undefined {
    if (this.tab === "memory") {
      const row: MemoryRow | undefined = memoryRows(this.levels).find((r) => r.id === id)
      if (!row) return undefined
      return { title: row.file?.path ?? row.level.path, text: memoryPreview(row) }
    }
    if (this.tab === "runs") {
      const run = this.runs.find((r) => r.id === id)
      return run ? { title: run.id, text: runDetail(run) } : undefined
    }
    const commit = this.commits.find((c) => c.hash === id)
    if (!commit) return undefined
    if (!this.diffs.has(commit.hash)) void this.loadDiff(commit.hash)
    const diff = this.diffs.get(commit.hash)
    if (diff === undefined) return { title: commit.hash, text: "_loading…_" }
    if (diff === "") return { title: commit.hash, text: "_commit not found in the memory repo_" }
    return { title: commit.hash, text: diff, lang: "diff" }
  }

  private previewLines(width: number, height: number): string[] {
    const id = this.selectedId()
    const src = id ? this.previewSource(id) : undefined
    if (!src) return []
    const key = `${this.tab}:${id}:${width}:${src.text.length}`
    if (this.previewCache?.key !== key) {
      const lines = src.lang
        ? highlightCode(src.text, src.lang)
        : new Markdown(src.text, 0, 0, getMarkdownTheme()).render(width)
      this.previewCache = { key, lines }
    }
    const lines = this.previewCache.lines
    const max = Math.max(0, lines.length - (height - 1))
    this.scroll = Math.min(this.scroll, max)
    const head = this.theme.fg("muted", `${this.tab} • ${src.title}`)
    return [head, ...lines.slice(this.scroll, this.scroll + height - 1)]
  }
}
