/**
 * Full-screen GitHub PR browser: open PRs of the cwd's repo (repo view) or
 * of the configured orgs (org view), stacked PRs as trees, rows coloured in
 * GitHub's visual language.
 *
 * Data access arrives through PrDeps; this module only renders and
 * dispatches keys. Read-only towards GitHub.
 */

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import {
  type Component,
  fuzzyFilter,
  Input,
  matchesKey,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui"
import {
  applyPreset,
  buildRows,
  fmtAge,
  haystack,
  isContextAddress,
  type Pr,
  type Preset,
  PRESETS,
  reviewContext,
  reviewRequested,
  type Row,
  type View,
} from "./model"

export interface Loaded {
  prs: Pr[]
  viewer: string
  /** More PRs matched than one page holds. */
  truncated: boolean
}

export interface PrDeps {
  /** Open PRs for a view; error text (gh's own) on failure. */
  load(view: View): Promise<Loaded | { error: string }>
  /** `owner/name` of the cwd's repo; actions only apply to its PRs. */
  localRepo: string | undefined
  /** What org view covers, for the header. */
  orgs: string[]
  /** View to open in. */
  view: View
  /** Check a PR out in the repo root or its own worktree; the outcome. */
  checkout(pr: Pr, where: CheckoutTarget): Promise<Outcome>
  /** Manifest names cue-review knows; error text on failure. */
  manifests(): Promise<string[] | { error: string }>
  /** Start a detached cue-review run for a PR. */
  launchReview(req: ReviewRequest): Promise<Outcome>
  /** Copy text to system clipboard. */
  copy(text: string): Promise<void>
}

export interface ReviewRequest {
  pr: Pr
  context: string
  parent?: string
  manifest: string
}

/** cue-review's preselected manifest. */
export const DEFAULT_MANIFEST = "default"

type Field = "context" | "parent" | "manifest"
const FIELDS: Field[] = ["context", "parent", "manifest"]

interface ReviewForm {
  pr: Pr
  context: Input
  parent: Input
  manifests: string[]
  manifest: number
  field: Field
  error: string
}

export type CheckoutTarget = "root" | "worktree"

/** Result of an action, shown in the footer. */
export interface Outcome {
  ok: boolean
  text: string
}

const pad = (s: string, w: number): string => truncateToWidth(s, w, "…", true)

const PRESET_LABEL: Record<Preset, string> = {
  all: "all",
  mine: "mine",
  review: "review requested",
}

type Tone = "success" | "error" | "warning" | "muted" | "dim"

const checksTone = (c: Pr["checks"]): Tone =>
  c === "SUCCESS" ? "success" : c === "FAILURE" || c === "ERROR" ? "error" : c ? "warning" : "dim"

const checksGlyph = (c: Pr["checks"]): string =>
  c === "SUCCESS" ? "✓" : c === "FAILURE" || c === "ERROR" ? "✗" : c ? "●" : " "

const rowId = (r: Row): string => (r.kind === "repo" ? `repo:${r.repo}` : `pr:${r.pr.repo}#${r.pr.number}`)

export class PrBrowser implements Component {
  protected input = new Input()
  protected view: View
  protected preset: Preset = "all"
  protected data: Partial<Record<View, Loaded>> = {}
  protected loading = false
  protected error = ""
  protected status: { text: string; tone: Tone } = { text: "", tone: "muted" }
  protected folded = new Set<string>()
  protected selectedId: string | undefined

  constructor(
    protected tui: TUI,
    protected theme: Theme,
    protected kb: KeybindingsManager,
    protected deps: PrDeps,
    protected done: () => void,
  ) {
    this.view = deps.view
    this.input.focused = true
    void this.reload()
  }

  close(): void {
    this.done()
  }

  protected notice(text: string, tone: Tone = "muted"): void {
    this.status = { text, tone }
    this.tui.requestRender()
  }

  protected async reload(): Promise<void> {
    if (this.loading) return
    this.loading = true
    this.tui.requestRender()
    const view = this.view
    const r = await this.deps.load(view)
    this.loading = false
    if ("error" in r) this.error = r.error
    else {
      this.error = ""
      // Org view starts with every repo collapsed; refreshes keep the folds.
      if (view === "org" && !this.data.org) for (const p of r.prs) this.folded.add(p.repo)
      this.data[view] = r
    }
    this.tui.requestRender()
  }

  protected rows(): Row[] {
    const d = this.data[this.view]
    if (!d) return []
    let prs = applyPreset(d.prs, this.preset, d.viewer)
    const q = this.input.getValue().trim()
    if (q) {
      const hit = new Set(fuzzyFilter(prs, q, haystack))
      prs = prs.filter((p) => hit.has(p))
    }
    // While searching, show matches inside folded repos too.
    return buildRows(prs, this.view, q ? new Set() : this.folded)
  }

  protected selectedIndex(rows: Row[]): number {
    const i = rows.findIndex((r) => rowId(r) === this.selectedId)
    if (i >= 0) return i
    const firstPr = rows.findIndex((r) => r.kind === "pr")
    return firstPr >= 0 ? firstPr : 0
  }

  protected selectedRow(): Row | undefined {
    const rows = this.rows()
    return rows[this.selectedIndex(rows)]
  }

  /** The highlighted PR, if it is one the cwd's repo can act on. */
  protected actionablePr(): Pr | undefined {
    const r = this.selectedRow()
    if (r?.kind !== "pr") return undefined
    if (r.pr.repo !== this.deps.localRepo) {
      this.notice(`${r.pr.repo} is not this repo (${this.deps.localRepo ?? "no GitHub origin"}); no local clone to act in`, "warning")
      return undefined
    }
    return r.pr
  }

  protected toggleFold(): void {
    if (this.view !== "org") return
    const r = this.selectedRow()
    if (!r) return
    const repo = r.kind === "repo" ? r.repo : r.pr.repo
    if (this.folded.has(repo)) this.folded.delete(repo)
    else this.folded.add(repo)
    this.selectedId = `repo:${repo}`
    this.tui.requestRender()
  }

  /** Move to the previous/next repo heading (org view). */
  protected hopRepo(rows: Row[], dir: -1 | 1): void {
    if (this.view !== "org") return
    for (let i = this.selectedIndex(rows) + dir; i >= 0 && i < rows.length; i += dir) {
      if (rows[i]!.kind === "repo") {
        this.selectedId = rowId(rows[i]!)
        return this.tui.requestRender()
      }
    }
  }

  handleInput(data: string): void {
    if (this.form) return this.handleForm(data, this.form)
    const rows = this.rows()
    const move = (delta: number) => {
      if (rows.length === 0) return
      const i = Math.max(0, Math.min(rows.length - 1, this.selectedIndex(rows) + delta))
      this.selectedId = rowId(rows[i]!)
      this.tui.requestRender()
    }
    const page = Math.max(1, this.bodyHeight() - 1)

    if (matchesKey(data, "escape")) return this.close()
    if (this.kb.matches(data, "tui.select.up")) return move(-1)
    if (this.kb.matches(data, "tui.select.down")) return move(1)
    if (this.kb.matches(data, "tui.select.pageUp")) return move(-page)
    if (this.kb.matches(data, "tui.select.pageDown")) return move(page)
    if (matchesKey(data, "tab")) {
      this.preset = PRESETS[(PRESETS.indexOf(this.preset) + 1) % PRESETS.length]!
      this.selectedId = undefined
      return this.tui.requestRender()
    }
    if (matchesKey(data, "alt+v")) {
      this.view = this.view === "repo" ? "org" : "repo"
      this.selectedId = undefined
      this.error = ""
      if (!this.data[this.view]) void this.reload()
      return this.tui.requestRender()
    }
    if (matchesKey(data, "ctrl+up")) return this.hopRepo(rows, -1)
    if (matchesKey(data, "ctrl+down")) return this.hopRepo(rows, 1)
    if (matchesKey(data, "alt+z")) return this.toggleFold()
    if (matchesKey(data, "ctrl+r")) return void this.reload()
    if (this.handleAction(data)) return

    const before = this.input.getValue()
    this.input.handleInput(data)
    if (this.input.getValue() !== before) {
      this.selectedId = undefined
      this.tui.requestRender()
    }
  }

  /** Hook for action keys; true when the key was consumed. */
  protected handleAction(data: string): boolean {
    const where = matchesKey(data, "enter") || matchesKey(data, "alt+w")
      ? "worktree"
      : matchesKey(data, "alt+o")
        ? "root"
        : undefined
    if (where) {
      this.onCheckout(where)
      return true
    }
    if (matchesKey(data, "alt+r")) {
      void this.openForm()
      return true
    }
    if (matchesKey(data, "ctrl+y")) {
      void this.onCopy("url")
      return true
    }
    if (matchesKey(data, "ctrl+h")) {
      void this.onCopy("title")
      return true
    }
    return false
  }

  private async onCopy(what: "url" | "title"): Promise<void> {
    const r = this.selectedRow()
    if (!r) return
    const text =
      r.kind === "pr"
        ? what === "url"
          ? r.pr.url
          : r.pr.title
        : what === "url"
          ? `https://github.com/${r.repo}`
          : r.repo
    if (!text) return
    try {
      await this.deps.copy(text)
      this.notice(`copied ${text}`, "success")
    } catch (err) {
      this.notice(`copy failed: ${err instanceof Error ? err.message : String(err)}`, "error")
    }
  }

  protected form: ReviewForm | undefined

  private async openForm(): Promise<void> {
    const pr = this.actionablePr()
    if (!pr || this.busy) return
    this.busy = true
    this.notice("loading manifests\u2026", "dim")
    const m = await this.deps.manifests().finally(() => (this.busy = false))
    if ("error" in m) return this.notice(`cue-review manifests: ${m.error}`, "error")
    const manifests = m.length > 0 ? m : [DEFAULT_MANIFEST]
    const context = new Input()
    context.setValue(reviewContext(pr))
    context.focused = true
    this.form = {
      pr,
      context,
      parent: new Input(),
      manifests,
      manifest: Math.max(0, manifests.indexOf(DEFAULT_MANIFEST)),
      field: "context",
      error: "",
    }
    this.input.focused = false
    this.notice("")
  }

  private closeForm(): void {
    this.form = undefined
    this.input.focused = true
    this.tui.requestRender()
  }

  private focus(f: ReviewForm, field: Field): void {
    f.field = field
    f.context.focused = field === "context"
    f.parent.focused = field === "parent"
    this.tui.requestRender()
  }

  private handleForm(data: string, f: ReviewForm): void {
    if (this.busy) return
    if (matchesKey(data, "escape")) return this.closeForm()
    const step = (d: number) => FIELDS[(FIELDS.indexOf(f.field) + d + FIELDS.length) % FIELDS.length]!
    if (matchesKey(data, "tab") || this.kb.matches(data, "tui.select.down")) return this.focus(f, step(1))
    if (matchesKey(data, "shift+tab") || this.kb.matches(data, "tui.select.up")) return this.focus(f, step(-1))
    if (matchesKey(data, "enter")) return void this.submit(f)
    if (f.field === "manifest") {
      const d = matchesKey(data, "left") ? -1 : matchesKey(data, "right") || matchesKey(data, "space") ? 1 : 0
      if (d) {
        f.manifest = (f.manifest + d + f.manifests.length) % f.manifests.length
        this.tui.requestRender()
      }
      return
    }
    f[f.field].handleInput(data)
    f.error = ""
    this.tui.requestRender()
  }

  private async submit(f: ReviewForm): Promise<void> {
    const context = f.context.getValue().trim()
    const parent = f.parent.getValue().trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(context)) f.error = "context must be a slug (letters, digits, . _ -)"
    else if (parent && !isContextAddress(parent)) f.error = "parent must be <org>/<repo>/<context>"
    if (f.error) return this.tui.requestRender()
    const req: ReviewRequest = { pr: f.pr, context, manifest: f.manifests[f.manifest]!, ...(parent ? { parent } : {}) }
    this.closeForm()
    await this.run(`starting review of #${f.pr.number}`, () => this.deps.launchReview(req))
  }

  private formLines(f: ReviewForm, width: number): string[] {
    const t = this.theme
    const labelW = 10
    const label = (field: Field) =>
      (f.field === field ? t.fg("accent", "\u203a ") : "  ") + t.fg("muted", pad(field, labelW))
    const inputW = Math.max(10, width - labelW - 2)
    const manifests = f.manifests
      .map((m, i) => (i === f.manifest ? t.fg("accent", t.bold(`[${m}]`)) : t.fg("dim", m)))
      .join(" ")
    return [
      t.fg("accent", t.bold(`review #${f.pr.number}`)) + " " + f.pr.title,
      t.fg("dim", "tab/up/down field \u2022 left/right manifest \u2022 enter start \u2022 esc cancel"),
      "",
      label("context") + (f.context.render(inputW)[0] ?? ""),
      label("parent") + (f.parent.render(inputW)[0] ?? ""),
      label("manifest") + manifests,
      "",
      f.error ? t.fg("error", f.error) : "",
    ]
  }

  protected busy = false

  protected async run(label: string, action: () => Promise<Outcome>): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.notice(`${label}…`, "dim")
    try {
      const o = await action()
      this.notice(o.text, o.ok ? "success" : "error")
    } catch (e) {
      this.notice(e instanceof Error ? e.message : String(e), "error")
    } finally {
      this.busy = false
    }
  }

  private onCheckout(where: CheckoutTarget): void {
    const pr = this.actionablePr()
    if (!pr) return
    void this.run(`checking out #${pr.number} (${where})`, () => this.deps.checkout(pr, where))
  }

  protected helpHints(): string[] {
    return [
      "tab preset",
      "alt+v view",
      "alt+z fold",
      "ctrl+up/down repo",
      "enter worktree",
      "alt+o root",
      "alt+r review",
      "ctrl+y url",
      "ctrl+h title",
      "ctrl+r refresh",
      "esc close",
    ]
  }

  // ---- rendering -------------------------------------------------------

  protected height(): number {
    return Math.max(8, this.tui.terminal.rows)
  }

  protected bodyHeight(): number {
    return this.height() - 5
  }

  invalidate(): void {
    this.input.invalidate()
  }

  render(width: number): string[] {
    const t = this.theme
    const height = this.height()
    const lines = [
      this.headerLine(width),
      truncateToWidth(t.fg("dim", this.helpHints().join(" • ")), width, "…"),
      this.input.render(width)[0] ?? "",
      t.fg("border", "─".repeat(width)),
      ...this.bodyLines(width, this.bodyHeight()),
    ]
    while (lines.length < height - 1) lines.push("")
    lines.push(this.footerLine())
    return lines.slice(0, height).map((l) => truncateToWidth(l, width))
  }

  protected footerLine(): string {
    const t = this.theme
    if (this.error) return t.fg("error", `gh: ${this.error}`)
    return t.fg(this.status.tone, this.status.text)
  }

  protected bodyLines(width: number, height: number): string[] {
    if (this.form) return this.formLines(this.form, width)
    return this.listLines(width, height)
  }

  private headerLine(width: number): string {
    const t = this.theme
    const d = this.data[this.view]
    const scope = this.view === "repo" ? (this.deps.localRepo ?? "?") : this.deps.orgs.join(", ")
    const counts = d
      ? `${applyPreset(d.prs, this.preset, d.viewer).length}/${d.prs.length} open` +
        (d.truncated ? " (truncated)" : "")
      : ""
    const parts = [
      t.fg("accent", t.bold("pull requests")),
      t.fg("warning", `[${this.view}]`),
      t.fg("muted", scope),
      t.fg("accent", `(${PRESET_LABEL[this.preset]})`),
      t.fg(d?.truncated ? "warning" : "muted", counts),
      this.loading ? t.fg("dim", "loading…") : "",
    ]
    return truncateToWidth(parts.filter(Boolean).join("  "), width)
  }

  private listLines(width: number, height: number): string[] {
    const t = this.theme
    const d = this.data[this.view]
    if (!d) return [t.fg("dim", this.loading ? "loading…" : "no data")]
    const rows = this.rows()
    if (rows.length === 0) return [t.fg("warning", this.preset === "all" ? "no open PRs" : "no PRs match (tab: preset)")]
    this.selectedId = rowId(rows[this.selectedIndex(rows)]!)

    const numW = Math.max(3, ...rows.map((r) => (r.kind === "pr" ? `#${r.pr.number}`.length : 0)))
    const authorW = Math.min(16, Math.max(6, ...rows.map((r) => (r.kind === "pr" ? r.pr.author.length : 0))))
    const ageW = 4
    const indentBase = this.view === "org" ? 2 : 0
    const lines: string[] = []
    let selLine = 0
    for (const r of rows) {
      const line = r.kind === "repo" ? this.repoLine(r, width) : this.prLine(r.pr, r.depth, indentBase, d.viewer, { numW, authorW, ageW }, width)
      if (rowId(r) === this.selectedId) {
        selLine = lines.length
        lines.push(t.bg("selectedBg", pad(line, width)))
      } else lines.push(line)
    }
    const start = Math.max(0, Math.min(selLine - Math.floor(height / 2), lines.length - height))
    return lines.slice(start, start + height)
  }

  private repoLine(r: Extract<Row, { kind: "repo" }>, width: number): string {
    const t = this.theme
    const local = r.repo === this.deps.localRepo ? t.fg("muted", " (here)") : ""
    return pad(
      `${t.fg("dim", r.folded ? "▸" : "▾")} ${t.fg("accent", t.bold(r.repo))}${local} ${t.fg("muted", String(r.count))}`,
      width,
    )
  }

  private prLine(
    pr: Pr,
    depth: number,
    indentBase: number,
    viewer: string,
    w: { numW: number; authorW: number; ageW: number },
    width: number,
  ): string {
    const t = this.theme
    const indent = " ".repeat(indentBase) + (depth > 0 ? "  ".repeat(depth - 1) + t.fg("dim", "└ ") : "")
    const state = pr.isDraft ? t.fg("muted", "◌") : t.fg("success", "●")
    const num = t.fg(pr.isDraft ? "muted" : "success", pad(`#${pr.number}`, w.numW))
    const age = t.fg("muted", pad(fmtAge(pr.createdAt), w.ageW))
    const author = t.fg("muted", pad(pr.author, w.authorW))
    const checks = t.fg(checksTone(pr.checks), checksGlyph(pr.checks))
    const forMe = reviewRequested(pr, viewer)
    const title = pr.isDraft
      ? t.fg("muted", pr.title)
      : forMe
        ? t.fg("warning", pr.title)
        : pr.title
    const labels = pr.labels.length > 0 ? " " + pr.labels.map((l) => t.fg("accent", `[${l}]`)).join(" ") : ""
    const branch = t.fg("dim", `(${pr.headRef})`)
    return pad(
      [indent + state, num, age, author, checks, title, branch + labels].join(" "),
      width,
    )
  }
}
