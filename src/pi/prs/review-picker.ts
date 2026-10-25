/**
 * Context picker for one PR, over the repo's context tree (as the cue
 * browser lists it). The PR browser hosts it full screen in two modes:
 *
 * - review: pick the parent of the review context; the context name and
 *   the manifest are side settings.
 * - link: pick the context the PR branch links to. Enter on a context
 *   links it; enter on the first row creates the named context without a
 *   parent; ctrl+n creates it under the highlighted context.
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
  /** The repo's context tree, pinned first. */
  rows: ContextRow[]
  recencyDays: number | undefined
  /** Link mode instead of review mode. */
  link?: boolean
  /** Address of the context to highlight first. */
  selected?: string
}

export interface PickerResult {
  /** Review: the review context. Link: the slug to link (and create). */
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
  /** 0 is "no parent"; i > 0 is shown context i - 1. */
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
    this.selected = i + 1
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
    const n = this.shown().length + 1
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
      return this.say("editing the review context: enter keep, esc undo")
    }
    if (matchesKey(data, "alt+a")) {
      this.recent = !this.recent
      this.selected = 0
      return this.say(this.recent ? `recent: ${this.days}d and pinned` : "all contexts")
    }
    if (matchesKey(data, "ctrl+up") || matchesKey(data, "ctrl+down")) {
      const next = Math.max(0, Math.min(RECENCY_STEPS.length - 1, this.step + (matchesKey(data, "ctrl+up") ? 1 : -1)))
      this.recent = true
      this.selected = 0
      if (next !== this.step) {
        this.step = next
        this.host.saveRecencyDays(this.days)
      }
      return this.say(`recency window ${this.days}d`)
    }
    const before = this.query.getValue()
    this.query.handleInput(data)
    if (this.query.getValue() !== before) {
      // Searching lands on the best match rather than "no parent".
      this.selected = this.query.getValue().trim() ? 1 : 0
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
      return this.say("")
    }
    if (matchesKey(data, "enter")) {
      const v = this.name.getValue().trim()
      if (!SLUG.test(v)) return this.say("context must be a slug (letters, digits, . _ -)", "error")
      this.name.setValue(v)
      stop()
      return this.say("")
    }
    this.name.handleInput(data)
    this.tui.requestRender()
  }

  /** Link mode: `create` makes a new context under the highlighted one. */
  private submit(create = false): void {
    const row = this.selected > 0 ? this.shown()[this.selected - 1] : undefined
    const name = this.name.getValue().trim()
    if (this.init.link) {
      if (row && !create) return this.host.submit({ context: row.slug })
      return this.host.submit({ context: name, create: true, ...(row ? { parent: row.address } : {}) })
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
        t.fg("muted", `pick the context for ${pr.headRef} (${scope})`)
      : t.fg("accent", t.bold(`review #${pr.number}`)) + "  " + pr.title + "  " +
        t.fg("muted", `pick the parent (${scope})`)
    const settings = link
      ? label("new context") + name
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

  private listLines(width: number, height: number): string[] {
    const t = this.theme
    const rows = this.shown()
    this.selected = Math.min(this.selected, rows.length)
    const q = this.query.getValue().trim()
    const tree = q === ""
    const mixed = new Set(rows.map((r) => r.scope)).size > 1
    const hidden = tree ? collapseTree(this.tree(), NONE).hidden : new Map<string, number>()
    const now = this.now()
    const all = [
      pad(t.fg("dim", this.init.link ? `  (new: ${this.name.getValue().trim()}, no parent)` : `  ${NO_PARENT}`), width),
      ...rows.map((r) =>
        contextLine(t, r, { tree, here: undefined, mixed, hidden, slugWidth: this.slugWidth, now, width })),
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
