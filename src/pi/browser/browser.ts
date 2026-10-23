/**
 * Full-screen cue browser: a list of contexts or artifacts on the left,
 * a markdown preview of the selection on the right. One component holds
 * a stack of views, so drilling from a context into its artifacts and
 * stepping back keeps the earlier view's filter and selection.
 *
 * Data access and side effects arrive through BrowserDeps; this module
 * only renders and dispatches keys.
 */

import { readFileSync } from "node:fs"
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
  type ArtifactRow,
  type ContextRow,
  isFinished,
  relativeAge,
  sortArtifacts,
  treePrefix,
  typeBadge,
} from "./model"

export interface ContextRef {
  address: string
  slug: string
}

export interface BrowserDeps {
  loadContexts(pinnedOnly: boolean): Promise<ContextRow[]>
  loadArtifacts(address: string): Promise<ArtifactRow[]>
  /** Context linked to this session, if any. */
  sessionAddress(): string | undefined
  /** Link a context to the session without telling the model. */
  link(address: string): Promise<void>
  /** Suspend pi and edit a file in $EDITOR; resolves when it exits. */
  editFile(path: string): Promise<void>
  /** Open a file in a new tmux window; returns an error message on failure. */
  openInTmux(path: string): string | undefined
}

export type BrowserStart =
  | { view: "contexts" }
  | { view: "artifacts"; context: ContextRef }

interface ContextsView {
  kind: "contexts"
  pinnedOnly: boolean
  rows: ContextRow[]
  query: string
  selected: number
  loading: boolean
}

interface ArtifactsView {
  kind: "artifacts"
  context: ContextRef
  rows: ArtifactRow[]
  query: string
  selected: number
  loading: boolean
}

type View = ContextsView | ArtifactsView

const MODE_COLOR: Record<string, Parameters<Theme["fg"]>[0]> = {
  research: "accent",
  design: "warning",
  build: "success",
  review: "error",
  learn: "muted",
}

const TYPE_COLOR: Record<string, Parameters<Theme["fg"]>[0]> = {
  task: "accent",
  spec: "warning",
  plan: "success",
  note: "muted",
  trace: "dim",
  review: "error",
  bin: "dim",
  tmp: "dim",
}

/** Wrap YAML frontmatter in a fenced block so Markdown does not mangle it. */
export function previewMarkdown(text: string): string {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!m) return text
  return "```yaml\n" + m[1] + "\n```\n" + text.slice(m[0].length)
}

/** The most common scope; rows from other scopes show theirs. */
function majorityScope(rows: readonly ContextRow[]): string {
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.scope, (counts.get(r.scope) ?? 0) + 1)
  let best = ""
  let n = 0
  for (const [s, c] of counts) if (c > n) [best, n] = [s, c]
  return best
}

const pad = (s: string, w: number): string =>
  truncateToWidth(s, w, "…", true)

export class CueBrowser implements Component {
  private views: View[] = []
  private input = new Input()
  private status = ""
  private previewScroll = 0
  private previewCache: { key: string; lines: string[] } | undefined
  private busy = false

  constructor(
    private tui: TUI,
    private theme: Theme,
    private kb: KeybindingsManager,
    private deps: BrowserDeps,
    private done: () => void,
    start: BrowserStart,
  ) {
    this.input.focused = true
    if (start.view === "contexts") this.pushContexts(true)
    else this.pushArtifacts(start.context)
  }

  private get view(): View {
    return this.views[this.views.length - 1]!
  }

  private pushContexts(pinnedOnly: boolean): void {
    const v: ContextsView = {
      kind: "contexts", pinnedOnly, rows: [], query: "", selected: 0, loading: true,
    }
    this.views.push(v)
    this.input.setValue("")
    void this.loadContexts(v)
  }

  private pushArtifacts(context: ContextRef): void {
    const v: ArtifactsView = {
      kind: "artifacts", context, rows: [], query: "", selected: 0, loading: true,
    }
    this.views.push(v)
    this.input.setValue("")
    void this.loadArtifacts(v)
  }

  private async loadContexts(v: ContextsView): Promise<void> {
    v.loading = true
    v.rows = await this.deps.loadContexts(v.pinnedOnly)
    v.loading = false
    // Start on the session's context when it is listed.
    const here = this.deps.sessionAddress()
    const i = v.rows.findIndex((r) => r.address === here)
    if (i >= 0 && v.query === "") v.selected = i
    this.refresh()
  }

  private async loadArtifacts(v: ArtifactsView): Promise<void> {
    v.loading = true
    v.rows = sortArtifacts(await this.deps.loadArtifacts(v.context.address))
    v.loading = false
    this.refresh()
  }

  private refresh(): void {
    this.previewCache = undefined
    this.tui.requestRender()
  }

  // ---- filtering -------------------------------------------------------

  private shownContexts(v: ContextsView): ContextRow[] {
    return fuzzyFilter(v.rows, v.query, (r) => `${r.slug} ${r.title} ${r.scope}`)
  }

  private shownArtifacts(v: ArtifactsView): ArtifactRow[] {
    return fuzzyFilter(v.rows, v.query, (r) => `${r.type} ${r.title} ${r.name}`)
  }

  private shownCount(): number {
    const v = this.view
    return v.kind === "contexts"
      ? this.shownContexts(v).length
      : this.shownArtifacts(v).length
  }

  private selectedContext(): ContextRow | undefined {
    const v = this.view
    return v.kind === "contexts" ? this.shownContexts(v)[v.selected] : undefined
  }

  private selectedArtifact(): ArtifactRow | undefined {
    const v = this.view
    return v.kind === "artifacts" ? this.shownArtifacts(v)[v.selected] : undefined
  }

  private selectedPath(): string | undefined {
    return this.selectedContext()?.path ?? this.selectedArtifact()?.path
  }

  // ---- input -----------------------------------------------------------

  handleInput(data: string): void {
    if (this.busy) return
    const v = this.view
    const move = (delta: number) => {
      const n = this.shownCount()
      v.selected = n === 0 ? 0 : Math.max(0, Math.min(n - 1, v.selected + delta))
      this.previewScroll = 0
      this.refresh()
    }
    const page = Math.max(1, this.bodyHeight() - 1)

    if (matchesKey(data, "escape")) return this.back()
    if (this.kb.matches(data, "tui.select.up")) return move(-1)
    if (this.kb.matches(data, "tui.select.down")) return move(1)
    if (this.kb.matches(data, "tui.select.pageUp")) return move(-page)
    if (this.kb.matches(data, "tui.select.pageDown")) return move(page)
    if (matchesKey(data, "ctrl+d")) return this.scrollPreview(Math.floor(page / 2))
    if (matchesKey(data, "ctrl+u")) return this.scrollPreview(-Math.floor(page / 2))
    if (matchesKey(data, "enter")) return void this.onEnter()
    if (matchesKey(data, "ctrl+t")) return this.onTmux()
    if (v.kind === "contexts") {
      if (matchesKey(data, "tab")) {
        v.pinnedOnly = !v.pinnedOnly
        v.selected = 0
        return void this.loadContexts(v)
      }
      if (matchesKey(data, "ctrl+l")) return void this.onLink()
      if (matchesKey(data, "ctrl+o")) return void this.onEdit()
    }

    const before = this.input.getValue()
    this.input.handleInput(data)
    const after = this.input.getValue()
    if (after !== before) {
      v.query = after
      v.selected = 0
      this.previewScroll = 0
      this.refresh()
    }
  }

  private back(): void {
    if (this.views.length > 1) {
      this.views.pop()
      this.input.setValue(this.view.query)
      this.status = ""
      this.refresh()
      return
    }
    this.done()
  }

  private scrollPreview(delta: number): void {
    this.previewScroll = Math.max(0, this.previewScroll + delta)
    this.tui.requestRender()
  }

  private async onEnter(): Promise<void> {
    const c = this.selectedContext()
    if (c) {
      this.status = ""
      this.pushArtifacts({ address: c.address, slug: c.slug })
      return
    }
    await this.onEdit()
  }

  private async onEdit(): Promise<void> {
    const path = this.selectedPath()
    if (!path) return
    this.busy = true
    try {
      await this.deps.editFile(path)
    } finally {
      this.busy = false
    }
    const v = this.view
    if (v.kind === "artifacts") await this.loadArtifacts(v)
    else this.refresh()
  }

  private onTmux(): void {
    const path = this.selectedPath()
    if (!path) return
    const err = this.deps.openInTmux(path)
    this.status = err ?? `opened ${path.split("/").slice(-2).join("/")} in tmux`
    this.tui.requestRender()
  }

  private async onLink(): Promise<void> {
    const c = this.selectedContext()
    if (!c) return
    await this.deps.link(c.address)
    this.done()
  }

  // ---- rendering -------------------------------------------------------

  private height(): number {
    return Math.max(8, this.tui.terminal.rows)
  }

  /** Rows available to the list and preview. */
  private bodyHeight(): number {
    return this.height() - 4
  }

  invalidate(): void {
    this.previewCache = undefined
    this.input.invalidate()
  }

  render(width: number): string[] {
    const t = this.theme
    const v = this.view
    const height = this.height()
    const body = this.bodyHeight()

    const listWidth = Math.max(40, Math.min(width - 30, Math.floor(width * 0.55)))
    const previewWidth = Math.max(10, width - listWidth - 3)

    const header = this.headerLine(width)
    const query = this.input.render(width)[0] ?? ""
    const rule = t.fg("border", "─".repeat(width))

    const list = v.kind === "contexts"
      ? this.contextLines(v, listWidth, body)
      : this.artifactLines(v, listWidth, body)
    const preview = this.previewLines(previewWidth, body)

    const sep = t.fg("border", " │ ")
    const lines = [header, query, rule]
    for (let i = 0; i < body; i++) {
      lines.push(pad(list[i] ?? "", listWidth) + sep + pad(preview[i] ?? "", previewWidth))
    }
    lines.push(this.footerLine(width))
    return lines.slice(0, height).map((l) => truncateToWidth(l, width))
  }

  private headerLine(width: number): string {
    const t = this.theme
    const v = this.view
    const here = this.deps.sessionAddress()
    const title = v.kind === "contexts"
      ? `Cue contexts ${t.fg("muted", v.pinnedOnly ? "(pinned)" : "(all)")}`
      : `Cue artifacts ${t.fg("muted", v.context.address)}`
    const right = here ? t.fg("dim", `session: ${here}`) : t.fg("dim", "session: none")
    const left = t.fg("accent", t.bold(title))
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right))
    return left + " ".repeat(gap) + right
  }

  private footerLine(width: number): string {
    const t = this.theme
    const v = this.view
    const hints = v.kind === "contexts"
      ? ["enter artifacts", "ctrl+l link", "ctrl+o edit", "ctrl+t tmux", "tab pinned/all", "ctrl+d/u preview", "esc close"]
      : ["enter edit", "ctrl+t tmux", "ctrl+d/u preview", this.views.length > 1 ? "esc back" : "esc close"]
    const text = this.status ? t.fg("warning", this.status) + t.fg("dim", "  ") : ""
    return truncateToWidth(text + t.fg("dim", hints.join(" • ")), width)
  }

  /** Window of `count` rows keeping `selected` visible. */
  private window(total: number, selected: number, count: number): [number, number] {
    const start = Math.max(0, Math.min(selected - Math.floor(count / 2), total - count))
    return [start, Math.min(total, start + count)]
  }

  private contextLines(v: ContextsView, width: number, height: number): string[] {
    const t = this.theme
    if (v.loading && v.rows.length === 0) return [t.fg("dim", "loading…")]
    const rows = this.shownContexts(v)
    if (rows.length === 0) return [t.fg("warning", v.pinnedOnly ? "no pinned contexts (tab: all)" : "no contexts")]
    v.selected = Math.min(v.selected, rows.length - 1)
    const tree = v.query.trim() === ""
    const here = this.deps.sessionAddress()
    const home = majorityScope(rows)
    const slugWidth = Math.min(
      40,
      Math.max(12, ...rows.map((r) => visibleWidth((tree ? treePrefix(r) : "") + r.slug))),
    )
    const now = Math.floor(Date.now() / 1000)
    const [a, b] = this.window(rows.length, v.selected, height)
    const out: string[] = []
    for (let i = a; i < b; i++) {
      const r = rows[i]!
      const sel = i === v.selected
      const pin = r.pinned ? t.fg("warning", "*") : " "
      const mark = r.address === here ? t.fg("accent", "●") : " "
      const name = (tree ? t.fg("dim", treePrefix(r)) : "") +
        (r.address === here ? t.fg("accent", r.slug) : r.slug)
      const mode = r.mode
        ? t.fg(MODE_COLOR[r.mode] ?? "muted", pad(r.mode.toUpperCase(), 8))
        : t.fg("dim", pad("—", 8))
      const age = t.fg("muted", relativeAge(r.lastLoggedAt, now).padStart(4))
      const kind = t.fg("dim", pad(r.kind ?? "", 9))
      const rest = t.fg("muted", r.title) +
        (r.scope !== home ? t.fg("dim", `  ${r.scope}`) : "")
      let line = `${pin}${mark} ${pad(name, slugWidth)} ${mode} ${age} ${kind} ${rest}`
      line = pad(line, width)
      out.push(sel ? t.bg("selectedBg", line) : line)
    }
    return out
  }

  private artifactLines(v: ArtifactsView, width: number, height: number): string[] {
    const t = this.theme
    if (v.loading && v.rows.length === 0) return [t.fg("dim", "loading…")]
    const rows = this.shownArtifacts(v)
    if (rows.length === 0) return [t.fg("warning", "no artifacts")]
    v.selected = Math.min(v.selected, rows.length - 1)
    const now = Math.floor(Date.now() / 1000)
    const titleWidth = Math.max(10, width - 5 - 1 - 1 - 1 - 1 - 4)
    const [a, b] = this.window(rows.length, v.selected, height)
    const out: string[] = []
    for (let i = a; i < b; i++) {
      const r = rows[i]!
      const sel = i === v.selected
      const badge = t.fg(TYPE_COLOR[r.type] ?? "muted", pad(typeBadge(r.type), 5))
      const caret = r.priority === "critical"
        ? t.fg("error", "»")
        : r.priority === "high" ? t.fg("warning", "›") : " "
      let title = pad(r.title, titleWidth)
      if (r.status === "closed") title = t.fg("dim", t.strikethrough(title))
      else if (isFinished(r.status)) title = t.fg("dim", title)
      const age = t.fg("muted", relativeAge(r.createdAt, now).padStart(4))
      const line = pad(`${badge} ${caret} ${title} ${age}`, width)
      out.push(sel ? t.bg("selectedBg", line) : line)
    }
    return out
  }

  private previewLines(width: number, height: number): string[] {
    const path = this.selectedPath()
    if (!path) return []
    const key = `${path}:${width}`
    if (this.previewCache?.key !== key) {
      let text: string
      try {
        text = readFileSync(path, "utf8")
      } catch {
        text = `_cannot read ${path}_`
      }
      const md = path.endsWith(".md")
        ? previewMarkdown(text)
        : "```\n" + text + "\n```"
      const lines = new Markdown(md, 0, 0, getMarkdownTheme()).render(width)
      this.previewCache = { key, lines }
    }
    const lines = this.previewCache.lines
    const max = Math.max(0, lines.length - height)
    this.previewScroll = Math.min(this.previewScroll, max)
    return lines.slice(this.previewScroll, this.previewScroll + height)
  }
}
