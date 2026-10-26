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
  type Pr,
  type Preset,
  PRESETS,
  prContext,
  prNote,
  reviewContext,
  reviewRequested,
  type Row,
  type View,
} from "./model"
import { ReviewPicker } from "./review-picker"
import type { ContextRow } from "../browser/model"
import type { SessionRow } from "../browser/sessions"
import type { Target } from "../lib/default-target"

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
  /** The session repo's context tree, pinned first: review parents. */
  contexts(): Promise<ContextRow[]>
  /** The cue browser's stored recency window for this repo. */
  recencyDays(): number | undefined
  saveRecencyDays(days: number): void
  /** Start a detached cue-review run for a PR. */
  launchReview(req: ReviewRequest): Promise<Outcome>
  /** Copy text to system clipboard. */
  copy(text: string): Promise<void>
  /** The session repo's cue scope (`org/repo`); new contexts land here. */
  scope: string | undefined
  /** Branch -> address of its linked context (branch.<b>.cue-context). */
  links(): Promise<Map<string, string>>
  /**
   * Link a branch to a context: an address, or with `create` a slug to
   * create in the repo scope first. The outcome carries the linked address.
   */
  link(branch: string, context: string, create?: { parent?: string }): Promise<Outcome>
  /** Start a pi session in a context, the note after the orientation; error text on failure. */
  startSession(address: string, target: Target, note: string): string | undefined
  /** Newest session of a context, read when needed. */
  latestSession(address: string): Promise<SessionRow | undefined>
  /** Resume a session; error text on failure. */
  resume(session: SessionRow, target: Target): string | undefined
  /** Path of the session this browser runs in. */
  currentSession(): string | undefined
  /** Where sessions open first. */
  target: Target
}

export interface ReviewRequest {
  pr: Pr
  context: string
  parent?: string
  manifest: string
}

/** cue-review's preselected manifest. */
export const DEFAULT_MANIFEST = "default"

export type CheckoutTarget = "root" | "worktree"

/** Result of an action, shown in the footer. */
export interface Outcome {
  ok: boolean
  text: string
  /** Checkout: where the PR's branch is checked out. */
  path?: string
  /** Link: the linked context's address. */
  address?: string
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
  protected links = new Map<string, string>()
  protected mode: CheckoutTarget = "worktree"
  protected target: Target

  constructor(
    protected tui: TUI,
    protected theme: Theme,
    protected kb: KeybindingsManager,
    protected deps: PrDeps,
    protected done: () => void,
  ) {
    this.view = deps.view
    this.target = deps.target
    this.input.focused = true
    void this.reload()
    void this.loadLinks()
  }

  protected async loadLinks(): Promise<void> {
    this.links = await this.deps.links()
    this.tui.requestRender()
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
    if (this.picker) return this.picker.handleInput(data)
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
    if (matchesKey(data, "enter")) {
      void this.onOpen()
      return true
    }
    if (matchesKey(data, "ctrl+s")) {
      void this.onNewSession()
      return true
    }
    if (matchesKey(data, "ctrl+o")) {
      void this.onCheckout()
      return true
    }
    if (matchesKey(data, "ctrl+n")) {
      void this.openLink()
      return true
    }
    if (matchesKey(data, "alt+w")) {
      this.mode = this.mode === "worktree" ? "root" : "worktree"
      this.tui.requestRender()
      return true
    }
    if (matchesKey(data, "ctrl+t")) {
      this.target = this.target === "here" ? "tmux" : "here"
      this.tui.requestRender()
      return true
    }
    if (matchesKey(data, "alt+r")) {
      void this.openPicker()
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

  protected picker: ReviewPicker | undefined

  /** Address the PR branch links to, if it is among the listed contexts. */
  private linkedAddress(pr: Pr, rows: ContextRow[]): string | undefined {
    const a = this.links.get(pr.headRef)
    return a && rows.some((r) => r.address === a) ? a : undefined
  }

  private async openPicker(): Promise<void> {
    const pr = this.actionablePr()
    if (!pr || this.busy) return
    this.busy = true
    this.notice("loading manifests and contexts\u2026", "dim")
    const [m, rows] = await Promise.all([this.deps.manifests(), this.deps.contexts()])
      .finally(() => (this.busy = false))
    if ("error" in m) return this.notice(`cue-review manifests: ${m.error}`, "error")
    const manifests = m.length > 0 ? m : [DEFAULT_MANIFEST]
    const linked = this.linkedAddress(pr, rows)
    this.picker = new ReviewPicker(this.tui, this.theme, this.kb, {
      pr,
      context: reviewContext(pr),
      manifests,
      manifest: Math.max(0, manifests.indexOf(DEFAULT_MANIFEST)),
      rows,
      recencyDays: this.deps.recencyDays(),
      ...(linked ? { selected: linked } : {}),
    }, {
      cancel: () => this.closePicker(),
      saveRecencyDays: (d) => this.deps.saveRecencyDays(d),
      submit: (r) => {
        this.closePicker()
        const req: ReviewRequest = { pr, context: r.context, manifest: r.manifest ?? DEFAULT_MANIFEST, ...(r.parent ? { parent: r.parent } : {}) }
        void this.run(`starting review of #${pr.number}`, () => this.deps.launchReview(req))
      },
    })
    this.input.focused = false
    this.notice("")
  }

  private closePicker(): void {
    this.picker = undefined
    this.input.focused = true
    this.tui.requestRender()
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

  /** Link the branch; the linked address, or undefined after a failure notice. */
  private async linkTo(pr: Pr, context: string, create?: { parent?: string }): Promise<string | undefined> {
    let address: string | undefined
    await this.run(`linking ${pr.headRef} to ${context}`, async () => {
      const o = await this.deps.link(pr.headRef, context, create)
      if (o.ok) address = o.address
      return o
    })
    if (address) this.links.set(pr.headRef, address)
    return address
  }

  /** Link the PR branch to a context of your choice (ctrl+n). */
  private async openLink(): Promise<void> {
    const pr = this.actionablePr()
    if (!pr || this.busy) return
    this.busy = true
    this.notice("loading contexts\u2026", "dim")
    const rows = await this.deps.contexts().finally(() => (this.busy = false))
    const linked = this.links.get(pr.headRef)
    const shown = this.linkedAddress(pr, rows)
    this.picker = new ReviewPicker(this.tui, this.theme, this.kb, {
      pr,
      context: prContext(pr),
      manifests: [],
      manifest: 0,
      rows,
      recencyDays: this.deps.recencyDays(),
      link: true,
      ...(this.deps.scope ? { scope: this.deps.scope } : {}),
      ...(linked ? { linked } : {}),
      ...(shown ? { selected: shown } : {}),
    }, {
      cancel: () => this.closePicker(),
      saveRecencyDays: (d) => this.deps.saveRecencyDays(d),
      submit: (r) => {
        this.closePicker()
        const create = r.create ? (r.parent ? { parent: r.parent } : {}) : undefined
        void this.linkTo(pr, r.context, create)
      },
    })
    this.input.focused = false
    this.notice("")
  }

  /**
   * The PR branch's context, linking it first when needed: to the repo
   * scope's context named after the branch, created when missing.
   */
  private async ensureLinked(pr: Pr): Promise<string | undefined> {
    const linked = this.links.get(pr.headRef)
    if (linked) return linked
    const slug = prContext(pr)
    const rows = await this.deps.contexts()
    const existing = rows.find((r) => r.scope === this.deps.scope && r.slug === slug)
    return existing ? this.linkTo(pr, existing.address) : this.linkTo(pr, slug, {})
  }

  /** Enter: work on the PR. Check out, then resume its context's newest session or start one. */
  private async onOpen(): Promise<void> {
    const pr = this.actionablePr()
    if (!pr || this.busy) return
    const address = await this.ensureLinked(pr)
    if (!address) return
    const session = this.deps.latestSession(address)
    const path = await this.checkoutPr(pr)
    const s = await session
    if (!path) return
    if (!s) return this.start(pr, address, path)
    if (s.path === this.deps.currentSession()) return this.notice("already in this session")
    const err = this.deps.resume(s, this.target)
    if (err) return this.notice(err, "error")
    if (this.target === "here") return this.close()
    this.notice(`resumed ${s.description.slice(0, 40)} in tmux`, "success")
  }

  /** Ctrl+s: check out and start a new session in the PR's context. */
  private async onNewSession(): Promise<void> {
    const pr = this.actionablePr()
    if (!pr || this.busy) return
    const address = await this.ensureLinked(pr)
    if (!address) return
    const path = await this.checkoutPr(pr)
    if (path) this.start(pr, address, path)
  }

  /** Ctrl+o: check out only. */
  private async onCheckout(): Promise<void> {
    const pr = this.actionablePr()
    if (pr && !this.busy) await this.checkoutPr(pr)
  }

  /** Check the PR out in the current mode; the checkout path on success. */
  private async checkoutPr(pr: Pr): Promise<string | undefined> {
    let path: string | undefined
    await this.run(`checking out #${pr.number} (${this.mode})`, async () => {
      const o = await this.deps.checkout(pr, this.mode)
      if (o.ok) path = o.path
      return o
    })
    return path
  }

  private start(pr: Pr, address: string, path: string): void {
    const err = this.deps.startSession(address, this.target, prNote(pr, path))
    if (err) return this.notice(err, "error")
    if (this.target === "here") return this.close()
    this.notice(`started a session for ${address} in tmux`, "success")
  }

  protected helpHints(): string[] {
    return [
      "tab preset",
      "alt+v view",
      "alt+z fold",
      "ctrl+up/down repo",
      "enter session",
      "ctrl+s new session",
      "ctrl+o checkout",
      "ctrl+n link",
      `alt+w ${this.mode}`,
      "ctrl+t target",
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
    this.picker?.invalidate()
  }

  render(width: number): string[] {
    if (this.picker) return this.picker.render(width)
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
      t.fg(this.target === "tmux" ? "warning" : "muted", `[${this.target}]`),
      t.fg("warning", `[${this.view}]`),
      t.fg("muted", scope),
      t.fg("accent", `(${PRESET_LABEL[this.preset]})`),
      t.fg(d?.truncated ? "warning" : "muted", counts),
      this.loading ? t.fg("dim", "loading…") : "",
      this.busy ? t.fg("warning", "working…") : "",
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
