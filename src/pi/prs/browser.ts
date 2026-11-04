/**
 * Full-screen GitHub PR browser: open PRs of the cwd's repo (repo view) or
 * of the configured orgs (org view), stacked PRs as trees, rows coloured in
 * GitHub's visual language.
 *
 * Data access arrives through PrDeps; this module only renders and
 * dispatches keys. Read-only towards GitHub.
 */

import {
  type Component,
  fuzzyFilter,
  Input,
  type KeyId,
  matchesKey,
  type TUI,
  truncateToWidth,
  wrapTextWithAnsi,
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
import { ContextPicker, type PickerResult } from "./context-picker"
import { type PrDetail, PreviewCache, prKey } from "./preview"
import type { Kb, SessionLike, Target, Theme } from "./ui"
import type { ContextRow } from "../browser/model"

export interface Loaded {
  prs: Pr[]
  viewer: string
  /** More PRs matched than one page holds. */
  truncated: boolean
  /** `<repo>: <error>` for each repo whose search failed. */
  failed: string[]
}

/**
 * Session-bound capabilities (pi only): opening PRs into sessions,
 * cue-review launches, branch-context linking. Standalone host pickers
 * omit the group and get a list-only browser.
 */
export interface SessionDeps {
  /** Manifest names cue-review knows; error text on failure. */
  manifests(): Promise<string[] | { error: string }>
  /** The session repo's context tree, pinned first: review parents. */
  contexts(): Promise<ContextRow[]>
  /** The cue browser's stored recency window for this repo. */
  recencyDays(): number | undefined
  saveRecencyDays(days: number): void
  /** Start a detached cue-review run for a PR. */
  launchReview(req: ReviewRequest): Promise<Outcome>
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
  latestSession(address: string): Promise<SessionLike | undefined>
  /** Resume a session; error text on failure. */
  resume(session: SessionLike, target: Target): string | undefined
  /** Path of the session this browser runs in. */
  currentSession(): string | undefined
  /** Address of the session's cue context, if any. */
  sessionContext(): string | undefined
  /** Where sessions open first. */
  target: Target
}

/** A host-attached picker action, dispatched by its key chord. */
export interface HostAction {
  /** Key chord as pi-tui writes it (e.g. "d", "ctrl+d"). */
  key: string
  label: string
  /** Ask y/n in the footer before running. */
  confirm?: boolean
  run(pr: Pr): Promise<Outcome>
}

export interface PrDeps {
  /** Open PRs for a view; error text (gh's own) on failure. */
  load(view: View): Promise<Loaded | { error: string }>
  detail(pr: Pr): Promise<PrDetail>
  previews: PreviewCache
  /** `owner/name` of the cwd's repo; actions only apply to its PRs. */
  localRepo: string | undefined
  /** What org view covers, for the header. */
  orgs: string[]
  /** View to open in. */
  view: View
  /** Check a PR out in the repo root or its own worktree; the outcome. */
  checkout(pr: Pr, where: CheckoutTarget): Promise<Outcome>
  /** Copy text to system clipboard. */
  copy(text: string): Promise<void>
  /** Render a Markdown message body to terminal lines. */
  markdown(body: string, width: number): string[]
  /** Session-bound capabilities; omit for a standalone host picker. */
  sessions?: SessionDeps
  /** Host actions for the highlighted PR, bound to their own keys. */
  actions?: (pr: Pr) => HostAction[]
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

export function commentLines(
  detail: PrDetail,
  width: number,
  theme: Theme,
  now = Date.now(),
  md: (body: string, width: number) => string[] = (body, w) => wrapTextWithAnsi(body, w),
): string[] {
  if (detail.threads.length === 0) return wrapTextWithAnsi(theme.fg("dim", "No comments yet"), width)
  const lines = [...wrapTextWithAnsi(theme.fg("muted", "COMMENTS / newest first"), width), ""]
  for (const [index, thread] of detail.threads.entries()) {
    if (index > 0) lines.push("", theme.fg("border", "─".repeat(width)), "")
    const label = thread.kind === "inline"
      ? `${thread.path ?? "Inline conversation"}${thread.line ? `:${thread.line}` : ""}`
      : thread.kind === "review" ? "Review summary" : "Conversation"
    lines.push(...wrapTextWithAnsi(theme.fg("muted", label), width))
    for (const [i, message] of thread.messages.entries()) {
      if (i > 0) lines.push("")
      lines.push(...wrapTextWithAnsi(theme.fg("dim", `@${message.author} · ${fmtAge(message.at, now)} ago`), width))
      lines.push(...md(message.body || "(empty comment)", width))
    }
  }
  return lines
}

const PREVIEW_KEYS = {
  "tui.altScreen.halfPageUp": ["ctrl+u", "scroll up"],
  "tui.altScreen.halfPageDown": ["ctrl+d", "scroll down"],
  "tui.altScreen.top": ["ctrl+home", "top"],
  "tui.altScreen.bottom": ["ctrl+end", "bottom"],
} as const

type PreviewAction = keyof typeof PREVIEW_KEYS

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
  protected mode: CheckoutTarget = "root"
  protected target: Target | undefined
  private preview = true
  private stacked = true
  private width = 80
  private previewKey: string | undefined
  protected previewScroll = 0
  private previewCache: { detail: PrDetail; width: number; minute: number; lines: string[] } | undefined
  private closed = false
  private previewChanged = () => {
    if (!this.closed) this.tui.requestRender()
  }

  constructor(
    protected tui: TUI,
    protected theme: Theme,
    protected kb: Kb,
    protected deps: PrDeps,
    protected done: () => void,
  ) {
    this.view = deps.view
    this.target = deps.sessions?.target
    this.input.focused = true
    void this.reload()
    void this.loadLinks()
  }

  protected async loadLinks(): Promise<void> {
    this.links = (await this.deps.sessions?.links()) ?? new Map()
    this.tui.requestRender()
  }

  close(): void {
    this.closed = true
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
      this.error = r.failed.length > 0 ? `${r.failed.length} repo(s) failed: ${r.failed.join("; ")}` : ""
      // Refreshes keep the operator's folds; the org view starts unfolded.
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

  /** The highlighted PR, when it is one this host can act on. */
  protected actionablePr(): Pr | undefined {
    const r = this.selectedRow()
    if (r?.kind !== "pr") return undefined
    if (this.deps.localRepo && r.pr.repo !== this.deps.localRepo) {
      this.notice(`${r.pr.repo} is not this repo (${this.deps.localRepo}); no local clone to act in`, "warning")
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

  /** zM/zR: fold every repo, or unfold them all. */
  protected toggleFoldAll(): void {
    if (this.view !== "org") return
    const repos = this.rows().filter((r): r is Extract<Row, { kind: "repo" }> => r.kind === "repo").map((r) => r.repo)
    if (repos.length === 0) return
    const open = repos.filter((r) => !this.folded.has(r))
    const current = this.selectedRow()
    if (open.length > 0) {
      for (const r of open) this.folded.add(r)
      // A PR row hid under its repo heading: snap to it.
      const repo = current?.kind === "pr" ? current.pr.repo : undefined
      this.selectedId = `repo:${repo ?? open[0]}`
    } else {
      this.folded.clear()
    }
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
    if (this.confirming) return this.confirmInput(data)
    const rows = this.rows()
    const move = (delta: number) => {
      if (rows.length === 0) return
      const i = Math.max(0, Math.min(rows.length - 1, this.selectedIndex(rows) + delta))
      this.selectedId = rowId(rows[i]!)
      this.tui.requestRender()
    }
    const page = Math.max(1, this.listHeight() - 1)

    if (matchesKey(data, "alt+p")) {
      this.preview = !this.preview
      return this.tui.requestRender()
    }
    if (matchesKey(data, "alt+l")) {
      this.stacked = !this.stacked
      return this.tui.requestRender()
    }
    const previewMatches = (action: PreviewAction) => this.previewKeys(action).some((key) => matchesKey(data, key))
    if (this.preview && (previewMatches("tui.altScreen.halfPageDown") || previewMatches("tui.altScreen.halfPageUp"))) {
      const step = Math.max(1, Math.floor(this.previewHeight() / 2))
      this.previewScroll = Math.max(0, this.previewScroll + (previewMatches("tui.altScreen.halfPageDown") ? step : -step))
      return this.tui.requestRender()
    }
    if (this.preview && (previewMatches("tui.altScreen.top") || previewMatches("tui.altScreen.bottom"))) {
      this.previewScroll = previewMatches("tui.altScreen.top") ? 0 : Number.MAX_SAFE_INTEGER
      return this.tui.requestRender()
    }
    if (matchesKey(data, "escape")) return this.close()
    if (this.kb.matches(data, "tui.select.up")) return move(-1)
    if (this.kb.matches(data, "tui.select.down")) return move(1)
    if (this.kb.matches(data, "tui.select.pageUp")) return move(-page)
    if (this.kb.matches(data, "tui.select.pageDown")) return move(page)
    if (matchesKey(data, "tab")) {
      // Skip presets with no matching PRs in the loaded view.
      const d = this.data[this.view]
      const empty = (p: Preset) => !d || "error" in d || applyPreset(d.prs, p, d.viewer).length === 0
      let i = PRESETS.indexOf(this.preset)
      for (let step = 1; step < PRESETS.length; step++) {
        const next = PRESETS[(i + step) % PRESETS.length]!
        if (!empty(next)) {
          i = (i + step) % PRESETS.length
          break
        }
      }
      this.preset = PRESETS[i]!
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
    if (matchesKey(data, "shift+tab")) return this.toggleFoldAll()
    if (matchesKey(data, "alt+r")) {
      this.deps.previews.clear()
      this.previewCache = undefined
      this.previewScroll = 0
      void this.reload()
      return this.tui.requestRender()
    }
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
    if (matchesKey(data, "alt+w")) {
      this.mode = this.mode === "worktree" ? "root" : "worktree"
      this.tui.requestRender()
      return true
    }
    if (matchesKey(data, "ctrl+t") && this.deps.sessions) {
      this.target = this.target === "here" ? "tmux" : "here"
      this.tui.requestRender()
      return true
    }
    if (matchesKey(data, "ctrl+r") && this.deps.sessions) {
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
    const row = this.selectedRow()
    if (row?.kind === "pr" && this.deps.actions) {
      for (const a of this.deps.actions(row.pr)) {
        if (matchesKey(data, a.key as Parameters<typeof matchesKey>[1])) {
          void this.runAction(a, row.pr)
          return true
        }
      }
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

  protected picker: ContextPicker | undefined

  private async openPicker(): Promise<void> {
    const s = this.deps.sessions
    const pr = this.actionablePr()
    if (!s || !pr || this.busy) return
    this.busy = true
    this.notice("loading manifests and contexts\u2026", "dim")
    const [m, rows] = await Promise.all([s.manifests(), s.contexts()])
      .finally(() => (this.busy = false))
    if ("error" in m) return this.notice(`cue-review manifests: ${m.error}`, "error")
    const manifests = m.length > 0 ? m : [DEFAULT_MANIFEST]
    this.picker = new ContextPicker(this.tui, this.theme, this.kb, {
      pr,
      context: reviewContext(pr),
      manifests,
      manifest: Math.max(0, manifests.indexOf(DEFAULT_MANIFEST)),
      rows,
      recencyDays: s.recencyDays(),
      ...(s.scope ? { scope: s.scope } : {}),
      branch: prContext(pr),
      ...(this.links.get(pr.headRef) ? { linked: this.links.get(pr.headRef)! } : {}),
    }, {
      cancel: () => this.closePicker(),
      saveRecencyDays: (d) => s.saveRecencyDays(d),
      submit: (r) => {
        this.closePicker()
        const manifest = r.manifest ?? DEFAULT_MANIFEST
        const req: ReviewRequest = { pr, context: r.context, manifest, ...(r.parent ? { parent: r.parent } : {}) }
        void this.run(`starting review of #${pr.number}`, () => s.launchReview(req))
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

  /** A host action awaiting y/n confirmation. */
  protected confirming: { action: HostAction; pr: Pr } | undefined

  protected currentActions(): HostAction[] {
    const row = this.selectedRow()
    if (!this.deps.actions || row?.kind !== "pr") return []
    return this.deps.actions(row.pr)
  }

  protected async runAction(a: HostAction, pr: Pr): Promise<void> {
    if (this.busy) return
    if (a.confirm) {
      this.confirming = { action: a, pr }
      this.status = { text: "", tone: "muted" }
      return this.tui.requestRender()
    }
    await this.run(a.label, () => a.run(pr))
  }

  private confirmInput(data: string): void {
    const c = this.confirming
    this.confirming = undefined
    if (!c) return
    if (matchesKey(data, "y") || matchesKey(data, "enter")) {
      void this.run(c.action.label, () => c.action.run(c.pr))
    } else {
      this.notice("cancelled")
    }
    this.tui.requestRender()
  }

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
    const s = this.deps.sessions
    if (!s) return undefined
    let address: string | undefined
    await this.run(`linking ${pr.headRef} to ${context}`, async () => {
      const o = await s.link(pr.headRef, context, create)
      if (o.ok) address = o.address
      return o
    })
    if (address) this.links.set(pr.headRef, address)
    return address
  }

  /**
   * The PR branch's context, explicitly selecting and linking an existing
   * context or creating one under a chosen parent. Undefined on cancel.
   */
  private async ensureLinked(pr: Pr): Promise<string | undefined> {
    const s = this.deps.sessions
    if (!s) return undefined
    const linked = this.links.get(pr.headRef)
    if (linked) return linked
    const slug = prContext(pr)
    const rows = await s.contexts()
    const selected = await this.pickContext(pr, slug, rows, "conversation")
    if (!selected) return undefined
    if (!selected.create) return this.linkTo(pr, selected.context)
    const created = await this.pickContext(pr, selected.context, rows, "parent")
    if (!created) return undefined
    return this.linkTo(pr, created.context, created.parent ? { parent: created.parent } : {})
  }

  /** Full-screen conversation or creation picker; undefined on cancel. */
  private pickContext(
    pr: Pr, slug: string, rows: ContextRow[], purpose: "conversation" | "parent",
  ): Promise<PickerResult | undefined> {
    return new Promise((resolve) => {
      const s = this.deps.sessions
      const here = s?.sessionContext()
      this.picker = new ContextPicker(this.tui, this.theme, this.kb, {
        purpose,
        pr,
        context: slug,
        branch: slug,
        manifests: [],
        manifest: 0,
        rows,
        recencyDays: s?.recencyDays(),
        ...(s?.scope ? { scope: s.scope } : {}),
        ...(here ? { here } : {}),
      }, {
        cancel: () => {
          this.closePicker()
          resolve(undefined)
        },
        saveRecencyDays: (d) => s?.saveRecencyDays(d),
        submit: (r) => {
          this.closePicker()
          resolve(r)
        },
      })
      this.input.focused = false
      this.notice("")
    })
  }

  /** Enter: work on the PR. Check out, then resume its context's newest session or start one. */
  private async onOpen(): Promise<void> {
    const s = this.deps.sessions
    const pr = this.actionablePr()
    if (!s || !pr || this.busy) return
    const address = await this.ensureLinked(pr)
    if (!address) return
    const session = s.latestSession(address)
    const path = await this.checkoutPr(pr)
    const sess = await session
    if (!path) return
    if (!sess) return this.start(pr, address, path)
    if (sess.path === s.currentSession()) return this.notice("already in this session")
    const err = s.resume(sess, s.target)
    if (err) return this.notice(err, "error")
    if (s.target === "here") return this.close()
    this.notice(`resumed ${sess.description.slice(0, 40)} in tmux`, "success")
  }

  /** Ctrl+s: check out and start a new session in the PR's context. */
  private async onNewSession(): Promise<void> {
    const s = this.deps.sessions
    const pr = this.actionablePr()
    if (!s || !pr || this.busy) return
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
    const s = this.deps.sessions
    if (!s) return
    const err = s.startSession(address, s.target, prNote(pr, path))
    if (err) return this.notice(err, "error")
    if (s.target === "here") return this.close()
    this.notice(`started a session for ${address} in tmux`, "success")
  }

  private previewKeys(action: PreviewAction): KeyId[] {
    const keys = this.kb.getKeys(action)
    return keys.length > 0 || Object.hasOwn(this.kb.getUserBindings(), action)
      ? keys : [PREVIEW_KEYS[action][0]]
  }

  protected helpHints(): string[] {
    const previewHints = this.preview ? (Object.keys(PREVIEW_KEYS) as PreviewAction[]).flatMap((action) => {
      const keys = this.previewKeys(action)
      return keys.length > 0 ? [`${keys.join("/")} ${PREVIEW_KEYS[action][1]}`] : []
    }) : []
    return [
      `alt+p ${this.preview ? "hide" : "show"} preview`,
      "alt+l layout",
      ...previewHints,
      "tab preset",
      "alt+v view",
      "alt+z fold", "shift+tab fold all",
      "ctrl+up/down repo",
      ...(this.deps.sessions
        ? ["enter session", "ctrl+s new session", "ctrl+o checkout", "alt+w checkout", "ctrl+t target", "ctrl+r review"]
        : ["ctrl+o checkout", "alt+w checkout"]),
      "ctrl+y url",
      "ctrl+h title",
      ...this.currentActions().map((a) => `${a.key} ${a.label}${a.confirm ? " (confirm)" : ""}`),
      "alt+r refresh",
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

  private isStacked(): boolean {
    return this.stacked || this.width < 5
  }

  private listHeight(): number {
    return this.preview && this.isStacked()
      ? Math.max(1, Math.floor((this.bodyHeight() - 1) * 0.4)) : this.bodyHeight()
  }

  private previewHeight(): number {
    return this.isStacked() ? Math.max(1, this.bodyHeight() - this.listHeight() - 1) : this.bodyHeight()
  }

  invalidate(): void {
    this.previewCache = undefined
    this.input.invalidate()
    this.picker?.invalidate()
  }

  render(width: number): string[] {
    if (this.picker) return this.picker.render(width)
    this.width = width
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
    if (this.confirming) {
      const { action, pr } = this.confirming
      return t.fg("warning", `${action.label} on ${pr.repo}#${pr.number} — y confirm, any key cancels`)
    }
    return t.fg(this.status.tone, this.status.text)
  }

  protected bodyLines(width: number, height: number): string[] {
    const row = this.selectedRow()
    const key = row?.kind === "pr" ? prKey(row.pr) : undefined
    if (key !== this.previewKey) {
      this.previewKey = key
      this.previewScroll = 0
      this.previewCache = undefined
    }
    if (!this.preview) return this.listLines(width, height)
    const pr = row?.kind === "pr" ? row.pr : undefined
    if (!this.isStacked()) {
      const listW = Math.max(1, Math.min(width - 4, Math.floor(width * 0.55)))
      const previewW = width - listW - 3
      const list = this.listLines(listW, height)
      const preview = this.previewLines(pr, previewW, height)
      const separator = this.theme.fg("border", " │ ")
      return Array.from({ length: height }, (_, i) =>
        pad(list[i] ?? "", listW) + separator + pad(preview[i] ?? "", previewW))
    }
    const listH = this.listHeight()
    const list = this.listLines(width, listH)
    while (list.length < listH) list.push("")
    return [
      ...list,
      this.theme.fg("border", "─".repeat(width)),
      ...this.previewLines(pr, width, this.previewHeight()),
    ]
  }

  private previewLines(pr: Pr | undefined, width: number, height: number): string[] {
    if (!pr) return [this.theme.fg("dim", "Select a PR to preview")]
    const entry = this.deps.previews.get(pr, this.deps.detail, this.previewChanged)
    if (entry.state === "loading") return [this.theme.fg("dim", `Loading ${prKey(pr)}…`)]
    if (entry.state === "error") return [this.theme.fg("error", `Preview: ${entry.error} (alt+r to retry)`)]
    const cache = this.previewCache
    const now = Date.now()
    const minute = Math.floor(now / 60_000)
    if (!cache || cache.detail !== entry.detail || cache.width !== width || cache.minute !== minute) {
      this.previewCache = {
        detail: entry.detail, width, minute,
        lines: commentLines(entry.detail, width, this.theme, now, this.deps.markdown),
      }
    }
    const lines = this.previewCache!.lines
    this.previewScroll = Math.min(this.previewScroll, Math.max(0, lines.length - height))
    return lines.slice(this.previewScroll, this.previewScroll + height)
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
      ...(this.deps.sessions ? [t.fg(this.target === "here" ? "warning" : "muted", `[${this.target}]`)] : []),
      t.fg(this.mode === "root" ? "warning" : "muted", `[${this.mode}]`),
      t.fg("muted", `[${this.view}]`),
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
    const title = forMe
      ? t.fg("warning", pr.title)
      : pr.isDraft
        ? t.fg("muted", pr.title)
        : pr.title
    const labels = pr.labels.length > 0 ? " " + pr.labels.map((l) => t.fg("accent", `[${l}]`)).join(" ") : ""
    const branch = t.fg("dim", `(${pr.headRef})`)
    return pad(
      [indent + state, num, age, author, checks, title, branch + labels].join(" "),
      width,
    )
  }
}
