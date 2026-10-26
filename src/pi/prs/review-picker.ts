/**
 * Context picker for one PR, over the repo's context tree (as the cue
 * browser lists it). The PR browser hosts it full screen in two modes:
 *
 * - review: pick the parent of the review context; the context name and
 *   the manifest are side settings.
 * - link: pick the context the PR branch links to. Enter on a context
 *   links it. The first row depends on the named context: when it exists
 *   in the repo scope it links it, else it creates it at the top level;
 *   while the branch is linked and the name is untouched there is no
 *   first row. ctrl+n creates the named context under the highlighted one.
 */

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import { Input, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui"
import { collapseTree, type ContextRow, RECENCY_STEPS, recencyIndex } from "../browser/model"
import { contextLine, shownContexts, slugWidthFor, treeRows } from "../browser/context-list"
import type { Pr } from "./model"

export interface PickerInit {
  pr: Pr
  /** Generated review context slug. */
  context: string
  manifests: string[]
  manifest: number
  /** The context tree as the cue browser lists it, pinned first. */
  rows: ContextRow[]
  recencyDays: number | undefined
  /** Link mode instead of review mode. */
  link?: boolean
  /** Address of the context to highlight first. */
  selected?: string
  /** Link mode: the session repo's scope, where new contexts land. */
  scope?: string
  /** Link mode: address the branch links to now. */
  linked?: string
}

export interface PickerResult {
  /** Review: the review context. Link: the address to link, or with create the slug to create. */
  context: string
  parent?: string
  /** Review mode only. */
  manifest?: string
  /** Link mode: create the context before linking. */
  create?: boolean
}

export interface PickerHost {
  submit(r: PickerResult): void
  cancel(): void
  saveRecencyDays(days: number): void
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const NO_PARENT = "(no parent)"
const NONE = new Set<string>()

export class ReviewPicker {
  private query = new Input()
  private name = new Input()
  /** Name before ctrl+e, restored by esc. */
  private saved = ""
  private editing = false
  private manifest: number
  private recent = true
  private step: number
  /** Index into the list: the first row (if any), then shown contexts. */
  private selected = 0
  private message: { text: string; tone: "error" | "muted" } = { text: "", tone: "muted" }
  private slugWidth: number

  constructor(
    private tui: TUI,
    private theme: Theme,
    private kb: KeybindingsManager,
    private init: PickerInit,
    private host: PickerHost,
  ) {
    this.name.setValue(init.context)
    this.manifest = init.manifest
    this.step = recencyIndex(init.recencyDays)
    this.query.focused = true
    this.slugWidth = slugWidthFor(init.rows, NONE, 12)
    if (init.selected) this.preselect(init.selected)
  }

  /** Highlight a context, widening to all contexts when the window hides it. */
  private preselect(address: string): void {
    let i = this.shown().findIndex((r) => r.address === address)
    if (i < 0) {
      this.recent = false
      i = this.shown().findIndex((r) => r.address === address)
      if (i < 0) this.recent = true
    }
    this.selected = i < 0 ? 0 : i + this.offset()
  }

  /** Link mode: an existing context in the repo scope named like the name. */
  private existing(): ContextRow | undefined {
    const name = this.name.getValue().trim()
    return this.init.rows.find((r) => r.scope === this.init.scope && r.slug === name)
  }

  /** The first row: no parent (review), link existing / create (link), or none. */
  private first(): "none-parent" | "existing" | "create" | undefined {
    if (!this.init.link) return "none-parent"
    const e = this.existing()
    if (this.init.linked && (!e || e.address === this.init.linked) && this.name.getValue().trim() === this.init.context) return undefined
    return e ? "existing" : "create"
  }

  private offset(): number {
    return this.first() ? 1 : 0
  }

  private get days(): number {
    return RECENCY_STEPS[this.step]!
  }

  private now(): number {
    return Math.floor(Date.now() / 1000)
  }

  private tree(): ContextRow[] {
    return treeRows(this.init.rows, this.recent, this.now(), this.days)
  }

  private shown(): ContextRow[] {
    return shownContexts(this.init.rows, this.query.getValue(), this.tree(), NONE)
  }

  private say(text: string, tone: "error" | "muted" = "muted"): void {
    this.message = { text, tone }
    this.tui.requestRender()
  }

  handleInput(data: string): void {
    if (this.editing) return this.handleEdit(data)
    const n = this.shown().length + this.offset()
    const move = (d: number) => {
      this.selected = Math.max(0, Math.min(n - 1, this.selected + d))
      this.tui.requestRender()
    }
    const page = Math.max(1, this.listHeight() - 1)
    if (matchesKey(data, "escape")) return this.host.cancel()
    if (this.kb.matches(data, "tui.select.up")) return move(-1)
    if (this.kb.matches(data, "tui.select.down")) return move(1)
    if (this.kb.matches(data, "tui.select.pageUp")) return move(-page)
    if (this.kb.matches(data, "tui.select.pageDown")) return move(page)
    if (matchesKey(data, "enter")) return this.submit()
    if (this.init.link && matchesKey(data, "ctrl+n")) return this.submit(true)
    if (!this.init.link && (matchesKey(data, "tab") || matchesKey(data, "shift+tab"))) {
      const d = matchesKey(data, "tab") ? 1 : -1
      const k = this.init.manifests.length
      this.manifest = (this.manifest + d + k) % k
      return this.tui.requestRender()
    }
    if (matchesKey(data, "ctrl+e")) {
      this.saved = this.name.getValue()
      this.editing = true
      this.query.focused = false
      this.name.focused = true
      // setValue leaves the cursor at the start; edits append.
      this.name.handleInput("\x05")
      return this.say(`editing the ${this.init.link ? "new" : "review"} context: enter keep, esc undo`)
    }
    if (matchesKey(data, "alt+a")) {
      this.recent = !this.recent
      this.selected = 0
      this.clamp()
      return this.say(this.recent ? `recent: ${this.days}d and pinned` : "all contexts")
    }
    if (matchesKey(data, "ctrl+up") || matchesKey(data, "ctrl+down")) {
      const next = Math.max(0, Math.min(RECENCY_STEPS.length - 1, this.step + (matchesKey(data, "ctrl+up") ? 1 : -1)))
      this.recent = true
      this.selected = 0
      this.clamp()
      if (next !== this.step) {
        this.step = next
        this.host.saveRecencyDays(this.days)
      }
      return this.say(`recency window ${this.days}d`)
    }
    const before = this.query.getValue()
    this.query.handleInput(data)
    if (this.query.getValue() !== before) {
      // Searching lands on the best match rather than the first row.
      this.selected = this.query.getValue().trim() ? this.offset() : 0
      this.message = { text: "", tone: "muted" }
    }
    this.tui.requestRender()
  }

  private handleEdit(data: string): void {
    const stop = () => {
      this.editing = false
      this.name.focused = false
      this.query.focused = true
    }
    if (matchesKey(data, "escape")) {
      this.name.setValue(this.saved)
      stop()
      this.selected = 0
      return this.say("")
    }
    if (matchesKey(data, "enter")) {
      const v = this.name.getValue().trim()
      if (!SLUG.test(v)) return this.say("context must be a slug (letters, digits, . _ -)", "error")
      this.name.setValue(v)
      stop()
      this.selected = 0
      return this.say(this.init.link && this.existing() ? `${v} exists: enter links it` : "")
    }
    this.name.handleInput(data)
    this.tui.requestRender()
  }

  /** Keep the selection inside the list when the first row comes and goes. */
  private clamp(): void {
    this.selected = Math.max(0, Math.min(this.selected, this.shown().length + this.offset() - 1))
  }

  /** Link mode: `create` makes a new context under the highlighted one. */
  private submit(create = false): void {
    this.clamp()
    const off = this.offset()
    const row = this.selected >= off ? this.shown()[this.selected - off] : undefined
    const name = this.name.getValue().trim()
    if (this.init.link) {
      const e = this.existing()
      if (create) {
        if (e) return this.say(`${name} exists; ctrl+e picks another name`, "error")
        return this.host.submit({ context: name, create: true, ...(row ? { parent: row.address } : {}) })
      }
      if (row) {
        if (row.address === this.init.linked) return this.say("already linked")
        return this.host.submit({ context: row.address })
      }
      if (e) return this.host.submit({ context: e.address })
      return this.host.submit({ context: name, create: true })
    }
    const parent = row?.address
    this.host.submit({
      context: this.name.getValue().trim(),
      manifest: this.init.manifests[this.manifest]!,
      ...(parent ? { parent } : {}),
    })
  }

  // ---- rendering -------------------------------------------------------

  private height(): number {
    return Math.max(8, this.tui.terminal.rows)
  }

  /** Rows left for the list below the five header lines and the footer. */
  private listHeight(): number {
    return this.height() - 6
  }

  invalidate(): void {
    this.query.invalidate()
    this.name.invalidate()
  }

  render(width: number): string[] {
    const t = this.theme
    const { pr } = this.init
    const manifests = this.init.manifests
      .map((m, i) => (i === this.manifest ? t.fg("accent", t.bold(`[${m}]`)) : t.fg("dim", m)))
      .join(" ")
    const label = (s: string) => t.fg("muted", s) + " "
    const nameW = Math.max(12, Math.min(48, width - 40))
    const name = this.editing
      ? (this.name.render(nameW)[0] ?? "")
      : t.fg("accent", truncateToWidth(this.name.getValue(), nameW, "…"))
    const scope = this.recent ? `recent ${this.days}d` : "all"
    const link = this.init.link
    const hints = this.editing
      ? ["enter keep", "esc undo"]
      : link
        ? ["enter link", "ctrl+n new under", "ctrl+e new name", "alt+a recent/all", "ctrl+up/down recency", "esc back"]
        : ["enter start", "tab manifest", "ctrl+e context", "alt+a recent/all", "ctrl+up/down recency", "esc back"]
    const head = link
      ? t.fg("accent", t.bold(`link #${pr.number}`)) + "  " + pr.title + "  " +
        t.fg("muted", `${pr.headRef} (${scope})`)
      : t.fg("accent", t.bold(`review #${pr.number}`)) + "  " + pr.title + "  " +
        t.fg("muted", `pick the parent (${scope})`)
    const settings = link
      ? this.linkState() + "   " + label("new context") + name
      : label("context") + name + "   " + label("manifest") + manifests
    const lines = [
      truncateToWidth(head, width),
      truncateToWidth(settings, width),
      truncateToWidth(t.fg("dim", hints.join(" • ")), width, "…"),
      this.query.render(width)[0] ?? "",
      t.fg("border", "─".repeat(width)),
      ...this.listLines(width, this.listHeight()),
    ]
    while (lines.length < this.height() - 1) lines.push("")
    lines.push(t.fg(this.message.tone, this.message.text))
    return lines.slice(0, this.height()).map((l) => truncateToWidth(l, width))
  }

  /** Where the branch links now, with the linked context's parent. */
  private linkState(): string {
    const t = this.theme
    const linked = this.init.linked
    if (!linked) return t.fg("warning", "not linked")
    const rows = this.init.rows
    const i = rows.findIndex((r) => r.address === linked)
    let parent: ContextRow | undefined
    if (i >= 0) {
      for (let j = i - 1; j >= 0; j--) {
        if (rows[j]!.depth < rows[i]!.depth) {
          parent = rows[j]
          break
        }
      }
    }
    return t.fg("muted", "linked ") + t.fg("accent", linked) +
      (parent ? t.fg("muted", ` under ${parent.address}`) : "")
  }

  private firstLine(): string | undefined {
    const t = this.theme
    const name = this.name.getValue().trim()
    switch (this.first()) {
      case "none-parent": return t.fg("dim", `  ${NO_PARENT}`)
      case "existing": return t.fg("dim", "  (link existing: ") + this.existing()!.address + t.fg("dim", ")")
      case "create": return t.fg("dim", `  (new: ${name}, top level)`)
      default: return undefined
    }
  }

  private listLines(width: number, height: number): string[] {
    const t = this.theme
    const rows = this.shown()
    this.clamp()
    const q = this.query.getValue().trim()
    const tree = q === ""
    const mixed = new Set(rows.map((r) => r.scope)).size > 1
    const hidden = tree ? collapseTree(this.tree(), NONE).hidden : new Map<string, number>()
    const now = this.now()
    const first = this.firstLine()
    const all = [
      ...(first ? [pad(first, width)] : []),
      ...rows.map((r) =>
        contextLine(t, r, { tree, here: this.init.linked, marked: this.init.linked, mixed, hidden, slugWidth: this.slugWidth, now, width })),
    ]
    if (rows.length === 0) {
      all.push(t.fg("warning", q ? "no matching contexts" : `no contexts active in ${this.days}d (alt+a: all)`))
    }
    const start = Math.max(0, Math.min(this.selected - Math.floor(height / 2), all.length - height))
    return all.slice(start, start + height).map((l, i) =>
      start + i === this.selected ? t.bg("selectedBg", pad(l, width)) : l)
  }
}

const pad = (s: string, w: number): string => truncateToWidth(s, w, "…", true)
