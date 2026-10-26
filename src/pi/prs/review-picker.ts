/**
 * Review context picker for one PR, over the repo's context tree (as the
 * cue browser lists it), hosted full screen by the PR browser. Enter on a
 * context reviews into it; the highlight starts on review-<branch>, else
 * <branch>, else the top. ctrl+n edits a new name (prefilled with
 * review-<branch>) and creates it under the highlighted context; existing
 * names are refused. tab cycles the manifest.
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
  /** The repo-scope context tree as the cue browser lists it, pinned first. */
  rows: ContextRow[]
  recencyDays: number | undefined
  /** The session repo's scope, where new contexts land. */
  scope?: string
  /** Branch context slug, highlighted when the review context does not exist. */
  branch?: string
}

export interface PickerResult {
  /** Slug of the context to review into. */
  context: string
  /** Set when the context is created: its parent's address, if any. */
  parent?: string
  manifest: string
}

export interface PickerHost {
  submit(r: PickerResult): void
  cancel(): void
  saveRecencyDays(days: number): void
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const NONE = new Set<string>()

export class ReviewPicker {
  private query = new Input()
  private name = new Input()
  /** Editing the name of a context to create under `under`. */
  private editing = false
  private under: ContextRow | undefined
  private manifest: number
  private recent = true
  private step: number
  /** Index into the shown contexts. */
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
    this.manifest = init.manifest
    this.step = recencyIndex(init.recencyDays)
    this.query.focused = true
    this.slugWidth = slugWidthFor(init.rows, NONE, 12)
    const start = this.existing(init.context) ?? (init.branch ? this.existing(init.branch) : undefined)
    if (start) this.preselect(start.address)
  }

  /** Highlight a context, widening to all contexts when the window hides it. */
  private preselect(address: string): void {
    let i = this.shown().findIndex((r) => r.address === address)
    if (i < 0) {
      this.recent = false
      i = this.shown().findIndex((r) => r.address === address)
      if (i < 0) this.recent = true
    }
    this.selected = Math.max(0, i)
  }

  /** An existing context in the repo scope with this slug. */
  private existing(slug: string): ContextRow | undefined {
    return this.init.rows.find((r) => (!this.init.scope || r.scope === this.init.scope) && r.slug === slug)
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

  private highlighted(): ContextRow | undefined {
    this.clamp()
    return this.shown()[this.selected]
  }

  handleInput(data: string): void {
    if (this.editing) return this.handleEdit(data)
    const n = this.shown().length
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
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      const d = matchesKey(data, "tab") ? 1 : -1
      const k = this.init.manifests.length
      this.manifest = (this.manifest + d + k) % k
      return this.tui.requestRender()
    }
    if (matchesKey(data, "ctrl+n")) {
      this.under = this.highlighted()
      this.editing = true
      this.name.setValue(this.init.context)
      this.query.focused = false
      this.name.focused = true
      // setValue leaves the cursor at the start; edits append.
      this.name.handleInput("\x05")
      return this.say(`new context ${this.under ? `under ${this.under.address}` : "at the top level"}: enter create, esc back`)
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
      // Searching lands on the best match rather than the first row.
      this.selected = 0
      this.message = { text: "", tone: "muted" }
    }
    this.tui.requestRender()
  }

  private handleEdit(data: string): void {
    if (matchesKey(data, "escape")) {
      this.stopEditing()
      return this.say("")
    }
    if (matchesKey(data, "enter")) {
      const v = this.name.getValue().trim()
      if (!SLUG.test(v)) return this.say("context must be a slug (letters, digits, . _ -)", "error")
      if (this.existing(v)) return this.say(`${v} exists; pick another name`, "error")
      const parent = this.under?.address
      this.stopEditing()
      return this.host.submit({ context: v, manifest: this.manifestName(), ...(parent ? { parent } : {}) })
    }
    this.name.handleInput(data)
    this.tui.requestRender()
  }

  private stopEditing(): void {
    this.editing = false
    this.under = undefined
    this.name.focused = false
    this.query.focused = true
  }

  /** Keep the selection inside the list. */
  private clamp(): void {
    this.selected = Math.max(0, Math.min(this.selected, this.shown().length - 1))
  }

  private manifestName(): string {
    return this.init.manifests[this.manifest]!
  }

  private submit(): void {
    const row = this.highlighted()
    if (!row) return this.say("no context: ctrl+n creates one", "error")
    this.host.submit({ context: row.slug, manifest: this.manifestName() })
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
    const scope = this.recent ? `recent ${this.days}d` : "all"
    const hints = this.editing
      ? ["enter create", "esc back"]
      : ["enter review here", "ctrl+n new under", "tab manifest", "alt+a recent/all", "ctrl+up/down recency", "esc back"]
    const head = t.fg("accent", t.bold(`review #${pr.number}`)) + "  " + pr.title + "  " +
      t.fg("muted", `pick the context (${scope})`)
    const settings = this.editing
      ? label(this.under ? `new under ${this.under.address}` : "new, top level") +
        (this.name.render(Math.max(12, Math.min(48, width - 40)))[0] ?? "")
      : label("manifest") + manifests
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
    this.clamp()
    const q = this.query.getValue().trim()
    const tree = q === ""
    const mixed = new Set(rows.map((r) => r.scope)).size > 1
    const hidden = tree ? collapseTree(this.tree(), NONE).hidden : new Map<string, number>()
    const now = this.now()
    const all = rows.map((r) =>
      contextLine(t, r, { tree, here: undefined, mixed, hidden, slugWidth: this.slugWidth, now, width }))
    if (rows.length === 0) {
      all.push(t.fg("warning", q ? "no matching contexts" : `no contexts active in ${this.days}d (alt+a: all)`))
    }
    const start = Math.max(0, Math.min(this.selected - Math.floor(height / 2), all.length - height))
    return all.slice(start, start + height).map((l, i) =>
      start + i === this.selected ? t.bg("selectedBg", pad(l, width)) : l)
  }
}

const pad = (s: string, w: number): string => truncateToWidth(s, w, "…", true)
