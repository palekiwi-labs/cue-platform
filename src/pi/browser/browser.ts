import type { Target } from "../lib/default-target"
/**
 * Full-screen cue browser: a list of contexts, or a list of artifacts
 * with an optional markdown preview beside or below it. One component holds
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
  sliceByColumn,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui"
import {
  type ActivityEvent,
  artifactPath,
  commitDetails,
  eventPreview,
  eventSummary,
  fmtWhen,
  kindLabel,
} from "./activity"
import { entryAddress, entryLink, fmtStamp, type LogEntry, logPreview, tracePath } from "./log"
import { contextLine, shownContexts, slugWidthFor, treeRows } from "./context-list"
import {
  artifactAddress,
  artifactFilename,
  type ArtifactRow,
  type ContextRow,
  collapseTree,
  CREATE_TYPES,
  filterRecent,
  isFinished,
  pinnedFirst,
  RECENCY_STEPS,
  recencyIndex,
  relativeAge,
  sortArtifacts,
  typeBadge,
} from "./model"
import {
  fmtTokens,
  groupSessions,
  NO_CONTEXT,
  type SessionListRow,
  type SessionRow,
  syntheticContext,
  transcript,
} from "./sessions"

export interface ContextRef {
  address: string
  slug: string
}

export interface BrowserDeps {
  /**
   * The whole context tree, in subtree recency order; archived ones on
   * request; only the repository's own scope when `repoScope`.
   */
  loadContexts(archived: boolean, repoScope: boolean): Promise<ContextRow[]>
  /** Stored recency window in days for this repository, if any. */
  recencyDays(): number | undefined
  /** Remember the recency window for this repository. */
  saveRecencyDays(days: number): void
  loadArtifacts(address: string): Promise<ArtifactRow[]>
  /** Context linked to this session, if any. */
  sessionAddress(): string | undefined
  /** Pin or unpin a context; returns an error message on failure. */
  setPinned(address: string, pinned: boolean): Promise<string | undefined>
  /** Archive or unarchive a context; returns an error message on failure. */
  setArchived(address: string, archived: boolean): Promise<string | undefined>
  /** Link a context to the session without telling the model. */
  link(address: string): Promise<void>
  /** Suspend pi and edit a file in $EDITOR; resolves when it exits. */
  editFile(path: string): Promise<void>
  /** Open a file in a new tmux window; returns an error message on failure. */
  openInTmux(path: string): string | undefined
  /** Copy text to the system clipboard. */
  copy(text: string): Promise<void>
  /** Create an artifact; resolves to its path or an error message. */
  create(
    address: string,
    type: string,
    filename: string,
  ): Promise<{ path: string } | { error: string }>
  /**
   * Start a fresh pi session with the context injected, here or in a
   * new tmux window; returns an error message on failure.
   */
  newSession(address: string, target: Target): string | undefined
  /** Sessions in the browser's scopes (only the repository's when `repoScope`). */
  loadSessions(repoScope: boolean): Promise<SessionRow[]>
  /** Path of this pi's active session file. */
  currentSession(): string | undefined
  /** Resume a session here or in tmux; returns an error message on failure. */
  resume(session: SessionRow, target: Target): string | undefined
  /** Delete a session file; resolves to what happened ("moved to trash"). */
  deleteSession(path: string): Promise<string>
  /** Clear every label in a session file. */
  clearLabels(path: string): void
  /** Create a child context; resolves to an error message on failure. */
  createContext(parent: string, slug: string): Promise<string | undefined>
  /** Store a session description (the active session included). */
  describeSession(path: string, text: string): Promise<void>
  /** Activity events of a context, newest first. */
  loadActivity(address: string): Promise<ActivityEvent[]>
  /** Log entries of a context, newest first. */
  loadLog(address: string): Promise<LogEntry[]>
  /** `git show` output for a commit, or null when unavailable. */
  gitShow(root: string, hash: string): string | null
  /** Root of the cue store. */
  storeRoot(): string
  /** Path of a pi session file by session id, if it exists locally. */
  sessionFile(sessionId: string): string | undefined
}

export type { Target } from "../lib/default-target"

/** Creation wizard: pick a type, then name the file. */
interface Wizard {
  context: ContextRef
  step: "type" | "name"
  typeIndex: number
  asPath: boolean
  input: Input
  error: string
}

export type BrowserStart =
  | { view: "contexts" }
  | { view: "artifacts"; context: ContextRef }
  | { view: "sessions" }
  | { view: "activity"; context: ContextRef }
  | { view: "log"; context: ContextRef }

interface ContextsView {
  kind: "contexts"
  /** The scope the rows were loaded with, to reload when it changed. */
  repoScope: boolean
  /** Recent contexts only, or the whole tree. */
  recent: boolean
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

/** Which sessions tab lists: grouped recent/all, or flat labeled. */
type SessionSubset = "all" | "recent" | "labeled"

interface SessionsView {
  kind: "sessions"
  /** Only this context's subtree, when opened from a context. */
  context?: ContextRef
  subset: SessionSubset
  /** The scope the rows were loaded with, to reload when it changed. */
  repoScope: boolean
  contexts: ContextRow[]
  sessions: SessionRow[]
  query: string
  selected: number
  loading: boolean
}

interface ActivityView {
  kind: "activity"
  context: ContextRef
  /** Events within the recency window, or all of them. */
  recent: boolean
  rows: ActivityEvent[]
  query: string
  selected: number
  loading: boolean
}

interface LogView {
  kind: "log"
  context: ContextRef
  /** Entries within the recency window, or all of them. */
  recent: boolean
  rows: LogEntry[]
  query: string
  selected: number
  loading: boolean
}

type View = ContextsView | ArtifactsView | SessionsView | ActivityView | LogView

const NEXT_SUBSET: Record<SessionSubset, SessionSubset> = {
  recent: "labeled",
  labeled: "all",
  all: "recent",
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

const pad = (s: string, w: number): string =>
  truncateToWidth(s, w, "…", true)

/** Cut or pad a preview line to the pane, without an ellipsis: previews never wrap. */
const clip = (s: string, w: number): string => truncateToWidth(s, w, "", true)


/** Markdown render width for unwrapped previews: wider than any line. */
const UNWRAPPED_WIDTH = 2000

export class CueBrowser implements Component {
  private views: View[] = []
  private input = new Input()
  private status = ""
  private previewScroll = 0
  private previewCache: { key: string; lines: string[] } | undefined
  private busy = false
  private target: Target
  private showPreview = true
  /** View kinds whose preview sits below the list; alt+l toggles the current one. */
  private stacked = new Set<string>(["activity", "log"])
  private wizard: Wizard | undefined
  /** Contexts whose children are hidden; survives tab toggles. */
  private collapsed = new Set<string>()
  /** Slug column width; only grows, so tab and filtering never shift it. */
  private slugWidth = 12
  /** Contexts whose sessions are folded; set up on the first sessions load. */
  private sessionFolds: Set<string> | undefined
  /** Sessions loaded once per browser; deletes edit this copy. */
  private sessionsCache: Promise<SessionRow[]> | undefined
  private confirmDelete: SessionRow | undefined
  /** Session being described, with its own prompt on the bottom line. */
  private describing: { session: SessionRow; input: Input } | undefined
  /** Creating a child of this context, with its own prompt on the bottom line. */
  private creating: { parent: ContextRef; input: Input } | undefined
  /** Index into RECENCY_STEPS for the recent tabs. */
  private recencyStep: number
  /** Sessions listed flat, newest first, instead of grouped by context. */
  private sessionsFlat = true
  private contextsFlat = false
  /** Contexts view lists archived contexts too. */
  private showArchived = false
  /** alt+s: only the repository's own scope (cue --scope repo). */
  private repoScope = false

  constructor(
    private tui: TUI,
    private theme: Theme,
    private kb: KeybindingsManager,
    private deps: BrowserDeps,
    private done: () => void,
    start: BrowserStart,
    target: Target,
  ) {
    this.target = target
    this.input.focused = true
    this.recencyStep = recencyIndex(deps.recencyDays())
    if (start.view === "contexts") this.pushContexts(true)
    else if (start.view === "sessions") this.pushSessions()
    else if (start.view === "activity") this.pushActivity(start.context)
    else if (start.view === "log") this.pushLog(start.context)
    else this.pushArtifacts(start.context)
  }

  private get view(): View {
    return this.views[this.views.length - 1]!
  }

  private get recencyDays(): number {
    return RECENCY_STEPS[this.recencyStep]!
  }

  private pushContexts(recent: boolean): void {
    const v: ContextsView = {
      kind: "contexts", repoScope: this.repoScope, recent, rows: [], query: "", selected: 0, loading: true,
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

  /**
   * Load rows, then select `keep` when it is shown, else the session's
   * context.
   */
  private async loadContexts(v: ContextsView, keep?: string): Promise<void> {
    v.loading = true
    v.repoScope = this.repoScope
    v.rows = pinnedFirst(await this.deps.loadContexts(this.showArchived, this.repoScope))
    v.loading = false
    this.growSlugWidth(v.rows)
    if (!(keep && this.selectContext(v, keep)) && v.query === "") this.selectHere(v)
    this.refresh()
  }

  private selectHere(v: ContextsView): void {
    const here = this.deps.sessionAddress()
    if (here) this.selectContext(v, here)
  }

  /** Widen (+1) or narrow (-1) the recency window, wrapping; kept per repository. */
  private stepRecency(delta: number): void {
    const v = this.view
    const n = RECENCY_STEPS.length
    const next = (this.recencyStep + delta + n) % n
    const keep = v.kind === "contexts" ? this.selectedContext()?.address : undefined
    this.recencyStep = next
    this.deps.saveRecencyDays(this.recencyDays)
    if (v.kind === "contexts") {
      if (!v.recent) v.recent = true
      if (!(keep && this.selectContext(v, keep))) v.selected = 0
    } else if (v.kind === "sessions") {
      if (v.subset !== "recent") v.subset = "recent"
      v.selected = 0
    } else if (v.kind === "activity" || v.kind === "log") {
      if (!v.recent) v.recent = true
      v.selected = 0
    }
    this.notify(`recency window ${this.recencyDays}d`)
    this.refresh()
  }

  private selectContext(v: ContextsView, address: string): boolean {
    const i = this.shownContexts(v).findIndex((r) => r.address === address)
    if (i >= 0) v.selected = i
    return i >= 0
  }

  private growSlugWidth(rows: ContextRow[]): void {
    this.slugWidth = slugWidthFor(rows, this.collapsed, this.slugWidth)
  }

  private pushSessions(context?: ContextRef): void {
    const v: SessionsView = {
      kind: "sessions", repoScope: this.repoScope, context,
      // A context's own sessions may be old, so that view starts on all.
      subset: context ? "all" : "recent", contexts: [], sessions: [], query: "",
      selected: 0, loading: true,
    }
    this.views.push(v)
    this.input.setValue("")
    void this.loadSessions(v, true)
  }

  private async loadSessions(v: SessionsView, focus = false): Promise<void> {
    v.loading = true
    v.repoScope = this.repoScope
    this.sessionsCache ??= this.deps.loadSessions(this.repoScope)
    const [contexts, sessions] = await Promise.all([
      this.deps.loadContexts(false, this.repoScope).then(pinnedFirst),
      this.sessionsCache,
    ])
    v.contexts = contexts
    v.sessions = sessions
    if (v.context) {
      // The context's subtree: its row and every deeper row after it.
      const i = contexts.findIndex((c) => c.address === v.context!.address)
      let j = i + 1
      while (i >= 0 && j < contexts.length && contexts[j]!.depth > contexts[i]!.depth) j++
      v.contexts = i >= 0 ? contexts.slice(i, j) : []
      const keep = new Set(v.contexts.map((c) => c.address))
      v.sessions = sessions.filter((s) => s.address !== undefined && keep.has(s.address))
    }
    v.loading = false
    const here = this.deps.sessionAddress()
    if (!this.sessionFolds) {
      this.sessionFolds = new Set(sessions.map((s) => s.address ?? NO_CONTEXT))
      if (here) this.sessionFolds.delete(here)
    }
    if (v.context && focus) this.sessionFolds.delete(v.context.address)
    if (focus) {
      const rows = this.shownSessions(v)
      const current = this.deps.currentSession()
      let i = rows.findIndex((r) => r.kind === "session" && r.session.path === current)
      if (i < 0) i = rows.findIndex((r) => r.kind === "context" && r.context.address === here)
      if (i >= 0) v.selected = i
      this.previewScroll = Number.MAX_SAFE_INTEGER
    }
    this.refresh()
  }

  /**
   * ctrl+r/a/g outside the contexts view: sessions, activity or log of
   * the view's context (the highlighted session's in the sessions view).
   * Activity and log replace each other so esc returns past both.
   */
  private jumpTo(kind: "sessions" | "activity" | "log"): void {
    const v = this.view
    const context = v.kind === "sessions"
      ? this.actionContext()
      : v.kind === "contexts" ? undefined : v.context
    if (!context) {
      this.notify(v.kind === "sessions" ? "this session has no cue context" : "no context")
      return this.tui.requestRender()
    }
    if (v.kind === "activity" || v.kind === "log") this.views.pop()
    if (kind === "sessions") this.pushSessions(context)
    else if (kind === "activity") this.pushActivity(context)
    else this.pushLog(context)
  }

  private pushActivity(context: ContextRef): void {
    const v: ActivityView = {
      kind: "activity", context, recent: true, rows: [], query: "", selected: 0,
      loading: true,
    }
    this.views.push(v)
    this.input.setValue("")
    void this.loadActivity(v)
  }

  private pushLog(context: ContextRef): void {
    const v: LogView = {
      kind: "log", context, recent: true, rows: [], query: "", selected: 0,
      loading: true,
    }
    this.views.push(v)
    this.input.setValue("")
    this.status = ""
    void this.loadLog(v)
  }

  private async loadLog(v: LogView): Promise<void> {
    v.loading = true
    v.rows = await this.deps.loadLog(v.context.address)
    v.loading = false
    this.refresh()
  }

  private async loadActivity(v: ActivityView): Promise<void> {
    v.loading = true
    v.rows = await this.deps.loadActivity(v.context.address)
    v.loading = false
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
    // A query searches the whole tree, collapsed, old or not.
    return shownContexts(v.rows, v.query, this.treeRows(v), this.collapsed, this.contextsFlat)
  }

  private now(): number {
    return Math.floor(Date.now() / 1000)
  }

  private treeRows(v: ContextsView): ContextRow[] {
    return treeRows(v.rows, v.recent, this.now(), this.recencyDays)
  }

  /** Contexts to group sessions under: recent ones count session activity too. */
  private sessionContexts(v: SessionsView): ContextRow[] {
    if (v.subset !== "recent") return v.contexts
    const newest = new Map<string, number>()
    for (const s of v.sessions) {
      if (s.address && s.modified > (newest.get(s.address) ?? 0)) newest.set(s.address, s.modified)
    }
    return filterRecent(v.contexts, this.now(), this.recencyDays, newest)
  }

  private shownSessions(v: SessionsView): SessionListRow[] {
    const flat = (list: SessionRow[]): SessionListRow[] => list
      .sort((a, b) => b.modified - a.modified)
      .map((session) => ({ kind: "session", session, context: this.contextOf(v, session) }))
    if (v.subset === "labeled") {
      const labeled = v.sessions.filter((s) => s.label !== undefined)
      return flat(v.query.trim() === "" ? labeled : this.matchSessions(v, labeled))
    }
    const orphans = v.subset === "all" && !v.context
    if (this.sessionsFlat && v.query.trim() === "") {
      // Newest first across contexts; recent keeps the window by session time.
      const since = this.now() - this.recencyDays * 86400
      const pool = groupSessions(v.contexts, v.sessions, new Set(), orphans)
        .flatMap((r) => (r.kind === "session" ? [r.session] : []))
      return flat(v.subset === "recent" ? pool.filter((s) => s.modified >= since) : pool)
    }
    if (v.query.trim() === "") {
      return groupSessions(this.sessionContexts(v), v.sessions, this.sessionFolds ?? new Set(), orphans)
    }
    // A query searches every session of the grouping, folded or not, and lists them flat.
    const pool = groupSessions(v.contexts, v.sessions, new Set(), !v.context)
      .flatMap((r) => (r.kind === "session" ? [r.session] : []))
    return flat(this.matchSessions(v, pool))
  }

  private matchSessions(v: SessionsView, list: SessionRow[]): SessionRow[] {
    return fuzzyFilter(list, v.query, (s) =>
      `${this.contextOf(v, s).slug} ${s.description} ${s.label ?? ""}`)
  }

  private contextOf(v: SessionsView, s: SessionRow): ContextRow {
    const address = s.address ?? NO_CONTEXT
    return v.contexts.find((c) => c.address === address) ?? syntheticContext(address)
  }

  private shownActivity(v: ActivityView): ActivityEvent[] {
    const rows = v.recent
      ? v.rows.filter((e) => e.timestamp >= Date.now() - this.recencyDays * 86400_000)
      : v.rows
    const q = v.query.trim()
    return q === "" ? rows : fuzzyFilter(rows, q, (e) => `${e.kind} ${eventSummary(e)}`)
  }

  private shownLog(v: LogView): LogEntry[] {
    const rows = v.recent
      ? v.rows.filter((e) => e.timestamp >= Date.now() - this.recencyDays * 86400_000)
      : v.rows
    const q = v.query.trim()
    return q === "" ? rows : fuzzyFilter(rows, q, (e) => e.title)
  }

  private selectedLog(): LogEntry | undefined {
    const v = this.view
    return v.kind === "log" ? this.shownLog(v)[v.selected] : undefined
  }

  private selectedActivity(): ActivityEvent | undefined {
    const v = this.view
    return v.kind === "activity" ? this.shownActivity(v)[v.selected] : undefined
  }

  private selectedSessionRow(): SessionListRow | undefined {
    const v = this.view
    return v.kind === "sessions" ? this.shownSessions(v)[v.selected] : undefined
  }

  /** The highlighted session, or a context row's newest session. */
  private selectedSession(): SessionRow | undefined {
    const r = this.selectedSessionRow()
    return r?.kind === "session" ? r.session : r?.sessions[0]
  }

  private shownArtifacts(v: ArtifactsView): ArtifactRow[] {
    return fuzzyFilter(v.rows, v.query, (r) => `${r.type} ${r.title} ${r.name}`)
  }

  private shownCount(): number {
    const v = this.view
    if (v.kind === "sessions") return this.shownSessions(v).length
    if (v.kind === "activity") return this.shownActivity(v).length
    if (v.kind === "log") return this.shownLog(v).length
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
    const e = this.selectedLog()
    if (e) return tracePath(e, this.deps.storeRoot()) ?? undefined
    return this.selectedContext()?.path ?? this.selectedArtifact()?.path
  }

  private selectedAddress(): string | undefined {
    const c = this.selectedContext()
    if (c) return c.address
    const s = this.selectedSessionRow()
    if (s) return s.context.address || undefined
    const v = this.view
    if (v.kind === "activity" || v.kind === "log") return v.context.address
    const a = this.selectedArtifact()
    return a && v.kind === "artifacts" ? artifactAddress(v.context.address, a.path) : undefined
  }

  /** The context actions apply to: the highlighted one, or the view's. */
  private actionContext(): ContextRef | undefined {
    const c = this.selectedContext()
    if (c) return { address: c.address, slug: c.slug }
    const s = this.selectedSessionRow()
    if (s) return s.context.address ? { address: s.context.address, slug: s.context.slug } : undefined
    const v = this.view
    return v.kind === "artifacts" ? v.context : undefined
  }

  private previewShown(): boolean {
    return this.view.kind !== "contexts" && this.showPreview
  }

  /** Sessions previews open at the end, where the conversation left off. */
  private previewStart(): number {
    return this.view.kind === "sessions" ? Number.MAX_SAFE_INTEGER : 0
  }

  private notify(msg: string): void {
    this.status = msg
    this.tui.requestRender()
  }

  // ---- input -----------------------------------------------------------

  handleInput(data: string): void {
    if (this.busy) return
    if (this.wizard) return this.wizardInput(this.wizard, data)
    if (this.confirmDelete) return this.confirmInput(this.confirmDelete, data)
    if (this.describing) return this.describeInput(this.describing, data)
    if (this.creating) return this.creatingInput(this.creating, data)
    const v = this.view
    const move = (delta: number) => {
      const n = this.shownCount()
      v.selected = n === 0 ? 0 : Math.max(0, Math.min(n - 1, v.selected + delta))
      this.previewScroll = this.previewStart()
      this.refresh()
    }
    const page = Math.max(1, this.bodyHeight() - 1)

    if (matchesKey(data, "escape")) return this.back()
    if (this.kb.matches(data, "tui.select.up")) return move(-1)
    if (this.kb.matches(data, "tui.select.down")) return move(1)
    if (this.kb.matches(data, "tui.select.pageUp")) return move(-page)
    if (this.kb.matches(data, "tui.select.pageDown")) return move(page)
    if (matchesKey(data, "enter")) return void this.onEnter()
    if (matchesKey(data, "ctrl+e")) return void this.onOpen()
    if (matchesKey(data, "ctrl+t")) {
      this.target = this.target === "here" ? "tmux" : "here"
      return this.tui.requestRender()
    }
    if (v.kind === "log") {
      if (matchesKey(data, "ctrl+y")) return void this.onCopyLog("address")
      if (matchesKey(data, "ctrl+h")) return void this.onCopyLog("link")
    }
    if (matchesKey(data, "ctrl+h")) return void this.onCopy("address")
    if (matchesKey(data, "ctrl+y")) return void this.onCopy("path")
    if (matchesKey(data, "ctrl+n")) {
      if (v.kind === "contexts") return this.startCreateContext()
      return this.startWizard()
    }
    if (matchesKey(data, "ctrl+s")) return this.onNewSession()
    if (matchesKey(data, "alt+r")) return this.reload()
    if (v.kind !== "artifacts") {
      if (matchesKey(data, "ctrl+up")) return this.stepRecency(1)
      if (matchesKey(data, "ctrl+down")) return this.stepRecency(-1)
    }
    if (v.kind === "contexts") {
      if (matchesKey(data, "tab")) {
        const keep = this.selectedContext()?.address
        v.recent = !v.recent
        v.selected = 0
        if (!(keep && this.selectContext(v, keep))) this.selectHere(v)
        return this.refresh()
      }
      if (matchesKey(data, "ctrl+l")) return void this.onLink()
      if (matchesKey(data, "alt+f")) return void this.onTogglePin(v)
      if (matchesKey(data, "alt+a")) return void this.onToggleArchive(v)
      if (matchesKey(data, "alt+v")) {
        this.showArchived = !this.showArchived
        return void this.loadContexts(v, this.selectedContext()?.address)
      }
      if (matchesKey(data, "alt+t")) {
        const keep = this.selectedContext()?.address
        this.contextsFlat = !this.contextsFlat
        v.selected = 0
        if (keep) this.selectContext(v, keep)
        return this.refresh()
      }
      if (matchesKey(data, "alt+z") && !this.contextsFlat) return this.onToggleCollapse(v)
      if (matchesKey(data, "ctrl+r")) {
        const c = this.selectedContext()
        if (c) this.pushSessions({ address: c.address, slug: c.slug })
        return
      }
      if (matchesKey(data, "ctrl+a")) {
        const c = this.selectedContext()
        if (c) this.pushActivity({ address: c.address, slug: c.slug })
        return
      }
      if (matchesKey(data, "ctrl+g")) {
        const c = this.selectedContext()
        if (c) this.pushLog({ address: c.address, slug: c.slug })
        return
      }
    } else if (v.kind === "activity" || v.kind === "log") {
      if (matchesKey(data, "tab")) {
        v.recent = !v.recent
        v.selected = 0
        return this.refresh()
      }
    } else {
      if (v.kind === "sessions") {
        if (matchesKey(data, "tab")) {
          v.subset = NEXT_SUBSET[v.subset]
          v.selected = 0
          this.previewScroll = this.previewStart()
          return void this.loadSessions(v)
        }
        if (matchesKey(data, "ctrl+l")) return void this.onLink()
        if (matchesKey(data, "alt+z")) return this.onFoldSessions(v)
        if (matchesKey(data, "alt+t")) {
          this.sessionsFlat = !this.sessionsFlat
          v.selected = 0
          this.previewScroll = this.previewStart()
          return this.refresh()
        }
        if (matchesKey(data, "ctrl+x")) return this.onDelete()
        if (matchesKey(data, "alt+u")) return this.onClearLabel()
        if (matchesKey(data, "alt+d")) return this.onDescribe()
      }
    }
    if ((v.kind === "contexts" || v.kind === "sessions") && matchesKey(data, "alt+s")) {
      this.repoScope = !this.repoScope
      return this.reloadIfScopeChanged()
    }
    if (v.kind !== "contexts") {
      if (matchesKey(data, "ctrl+r") && v.kind !== "sessions") return this.jumpTo("sessions")
      if (matchesKey(data, "ctrl+a") && v.kind !== "activity") return this.jumpTo("activity")
      if (matchesKey(data, "ctrl+g") && v.kind !== "log") return this.jumpTo("log")
    }
    if (v.kind !== "contexts") {
      if (matchesKey(data, "alt+p")) {
        this.showPreview = !this.showPreview
        return this.refresh()
      }
      if (matchesKey(data, "alt+l")) {
        if (!this.stacked.delete(v.kind)) this.stacked.add(v.kind)
        return this.refresh()
      }
      if (this.showPreview && matchesKey(data, "ctrl+d")) return this.scrollPreview(Math.floor(page / 2))
      if (this.showPreview && matchesKey(data, "ctrl+u")) return this.scrollPreview(-Math.floor(page / 2))
      if (this.showPreview && matchesKey(data, "ctrl+home")) return this.scrollTo(0)
      if (this.showPreview && matchesKey(data, "ctrl+end")) return this.scrollTo(Number.MAX_SAFE_INTEGER)
    }

    const before = this.input.getValue()
    this.input.handleInput(data)
    const after = this.input.getValue()
    if (after !== before) {
      v.query = after
      v.selected = 0
      this.previewScroll = this.previewStart()
      this.refresh()
    }
  }

  /** alt+r: reread the view's rows from cue (and previews), keeping the selection. */
  private reload(): void {
    const v = this.view
    this.notify("reloaded")
    if (v.kind === "contexts") return void this.loadContexts(v, this.selectedContext()?.address)
    if (v.kind === "sessions") {
      this.sessionsCache = undefined
      return void this.loadSessions(v)
    }
    if (v.kind === "activity") return void this.loadActivity(v)
    if (v.kind === "log") return void this.loadLog(v)
    return void this.loadArtifacts(v)
  }

  /** Reload the shown contexts or sessions when alt+s changed the scope since. */
  private reloadIfScopeChanged(): void {
    const v = this.view
    if ((v.kind !== "contexts" && v.kind !== "sessions") || v.repoScope === this.repoScope) return
    if (v.kind === "contexts") return void this.loadContexts(v, this.selectedContext()?.address)
    this.sessionsCache = undefined
    v.selected = 0
    void this.loadSessions(v)
  }

  private back(): void {
    if (this.views.length > 1) {
      this.views.pop()
      this.input.setValue(this.view.query)
      this.status = ""
      this.reloadIfScopeChanged()
      this.refresh()
      return
    }
    this.done()
  }

  private scrollPreview(delta: number): void {
    this.previewScroll = Math.max(0, this.previewScroll + delta)
    this.tui.requestRender()
  }

  /** Jump the preview to a position (MAX_SAFE_INTEGER = bottom). */
  private scrollTo(pos: number): void {
    this.previewScroll = pos
    this.tui.requestRender()
  }

  private async onEnter(): Promise<void> {
    if (this.view.kind === "sessions") return this.onResume()
    const c = this.selectedContext()
    if (c) {
      this.status = ""
      this.pushArtifacts({ address: c.address, slug: c.slug })
      return
    }
    await this.onOpen()
  }

  private async onOpen(path = this.selectedPath()): Promise<void> {
    if (!path) return
    if (this.target === "tmux") return this.onTmux(path)
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

  private onTmux(path: string): void {
    const err = this.deps.openInTmux(path)
    this.notify(err ?? `opened ${path.split("/").slice(-2).join("/")} in tmux`)
  }

  private async onCopy(what: "address" | "path"): Promise<void> {
    const text = what === "address"
      ? this.selectedAddress()
      : this.selectedSessionRow()?.kind === "session"
        ? this.selectedSession()?.path
        : this.selectedPath()
    if (text) await this.copyText(text)
  }

  /** Log view: the entry's address, or a markdown link titled by it. */
  private async onCopyLog(what: "address" | "link"): Promise<void> {
    const v = this.view
    const e = this.selectedLog()
    if (!e || v.kind !== "log") return
    const ctx = v.context.address
    await this.copyText(what === "address" ? entryAddress(e, ctx) : entryLink(e, ctx))
  }

  private async copyText(text: string): Promise<void> {
    try {
      await this.deps.copy(text)
      this.notify(`copied ${text}`)
    } catch (e) {
      this.notify(`copy failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private onNewSession(): void {
    const c = this.actionContext()
    if (!c) return
    const err = this.deps.newSession(c.address, this.target)
    if (err) return this.notify(err)
    if (this.target === "here") return this.done()
    this.notify(`started a session for ${c.slug} in tmux`)
  }

  // ---- creation wizard -------------------------------------------------

  private startWizard(): void {
    const context = this.actionContext()
    if (!context) return
    const input = new Input()
    input.focused = true
    this.wizard = { context, step: "type", typeIndex: 0, asPath: false, input, error: "" }
    this.status = ""
    this.tui.requestRender()
  }

  private wizardInput(w: Wizard, data: string): void {
    if (matchesKey(data, "escape")) {
      if (w.step === "name") w.step = "type"
      else this.wizard = undefined
      return this.tui.requestRender()
    }
    if (w.step === "type") {
      const n = CREATE_TYPES.length
      if (this.kb.matches(data, "tui.select.up")) w.typeIndex = (w.typeIndex + n - 1) % n
      else if (this.kb.matches(data, "tui.select.down")) w.typeIndex = (w.typeIndex + 1) % n
      else if (matchesKey(data, "enter")) w.step = "name"
      return this.tui.requestRender()
    }
    if (matchesKey(data, "tab")) w.asPath = !w.asPath
    else if (matchesKey(data, "enter")) return void this.wizardCreate(w)
    else w.input.handleInput(data)
    w.error = ""
    this.tui.requestRender()
  }

  private async wizardCreate(w: Wizard): Promise<void> {
    const filename = artifactFilename(w.input.getValue(), w.asPath, CREATE_TYPES[w.typeIndex] !== "tmp")
    if (!filename) {
      w.error = "enter a name"
      return this.tui.requestRender()
    }
    const type = CREATE_TYPES[w.typeIndex]!
    this.busy = true
    const res = await this.deps.create(w.context.address, type, filename)
    this.busy = false
    if ("error" in res) {
      w.error = res.error
      return this.tui.requestRender()
    }
    this.wizard = undefined
    this.notify(`created ${type}/${filename}`)
    const v = this.view
    if (v.kind === "artifacts" && v.context.address === w.context.address) void this.loadArtifacts(v)
    await this.onOpen(res.path)
  }

  private async onTogglePin(v: ContextsView): Promise<void> {
    const c = this.selectedContext()
    if (!c) return
    this.busy = true
    const err = await this.deps.setPinned(c.address, !c.pinned)
    this.busy = false
    if (err) return this.notify(err)
    this.notify(`${c.pinned ? "unpinned" : "pinned"} ${c.slug}`)
    await this.loadContexts(v, c.address)
  }

  private async onToggleArchive(v: ContextsView): Promise<void> {
    const c = this.selectedContext()
    if (!c) return
    const archive = c.archivedAt === null
    const index = v.selected
    this.busy = true
    const err = await this.deps.setArchived(c.address, archive)
    this.busy = false
    if (err) return this.notify(err)
    this.notify(`${archive ? "archived" : "unarchived"} ${c.slug}`)
    if (archive && !this.showArchived) {
      // The row is gone: leave the cursor where it was, on the next row.
      await this.loadContexts(v, "")
      v.selected = index
      return this.refresh()
    }
    await this.loadContexts(v, c.address)
  }

  private onToggleCollapse(v: ContextsView): void {
    const c = this.selectedContext()
    if (!c || v.query.trim() !== "") return
    if (this.collapsed.has(c.address)) this.collapsed.delete(c.address)
    else this.collapsed.add(c.address)
    this.growSlugWidth(v.rows)
    this.selectContext(v, c.address)
    this.refresh()
  }

  private onResume(): void {
    const s = this.selectedSession()
    if (!s) return
    if (s.path === this.deps.currentSession()) return this.notify("already in this session")
    const err = this.deps.resume(s, this.target)
    if (err) return this.notify(err)
    if (this.target === "here") return this.done()
    this.notify(`resumed ${s.description.slice(0, 40)} in tmux`)
  }

  /** Fold or unfold the sessions of the row's context. */
  private onFoldSessions(v: SessionsView): void {
    const r = this.selectedSessionRow()
    if (!r || v.query.trim() !== "" || v.subset === "labeled" || this.sessionsFlat || !this.sessionFolds) return
    const address = r.context.address
    if (this.sessionFolds.has(address)) this.sessionFolds.delete(address)
    else this.sessionFolds.add(address)
    const i = this.shownSessions(v).findIndex((x) => x.kind === "context" && x.context.address === address)
    if (i >= 0) v.selected = i
    this.refresh()
  }

  private onDelete(): void {
    const r = this.selectedSessionRow()
    if (r?.kind !== "session") return this.notify("select a session row to delete")
    if (r.session.path === this.deps.currentSession()) return this.notify("cannot delete the active session")
    this.confirmDelete = r.session
    this.tui.requestRender()
  }

  private onClearLabel(): void {
    const r = this.selectedSessionRow()
    if (r?.kind !== "session") return this.notify("select a session row to unlabel")
    const s = r.session
    if (s.label === undefined) return this.notify("session has no label")
    if (s.path === this.deps.currentSession()) return this.notify("cannot unlabel the active session")
    try {
      this.deps.clearLabels(s.path)
    } catch (e) {
      return this.notify(`unlabel failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    // Rows are shared between the cache and views, so this updates both.
    s.label = undefined
    const v = this.view
    if (v.kind === "sessions" && v.selected >= this.shownSessions(v).length) {
      v.selected = Math.max(0, v.selected - 1)
    }
    this.notify("label cleared")
    this.refresh()
  }

  private startCreateContext(): void {
    const c = this.selectedContext()
    if (!c) return this.notify("select a parent context")
    const input = new Input()
    input.focused = true
    this.creating = { parent: { address: c.address, slug: c.slug }, input }
    this.status = ""
    this.tui.requestRender()
  }

  private creatingInput(d: { parent: ContextRef; input: Input }, data: string): void {
    if (matchesKey(data, "escape")) {
      this.creating = undefined
      this.status = ""
    } else if (matchesKey(data, "enter")) {
      this.creating = undefined
      const slug = d.input.getValue().trim()
      if (slug) void this.createContext(d.parent, slug)
    } else {
      d.input.handleInput(data)
    }
    this.tui.requestRender()
  }

  private async createContext(parent: ContextRef, slug: string): Promise<void> {
    let err: string | undefined
    try {
      err = await this.deps.createContext(parent.address, slug)
    } catch (e) {
      err = e instanceof Error ? e.message : String(e)
    }
    if (err) return this.notify(`create failed: ${err}`)
    const v = this.view
    const address = `${parent.address}/${slug}`
    this.notify(`created context ${slug}`)
    if (v.kind === "contexts") void this.loadContexts(v, address)
    else this.refresh()
  }

  private onDescribe(): void {
    const r = this.selectedSessionRow()
    if (r?.kind !== "session") return this.notify("select a session row to describe")
    const input = new Input()
    input.focused = true
    input.setValue(r.session.description)
    this.describing = { session: r.session, input }
    this.tui.requestRender()
  }

  private describeInput(d: { session: SessionRow; input: Input }, data: string): void {
    if (matchesKey(data, "escape")) {
      this.describing = undefined
      this.status = ""
    } else if (matchesKey(data, "enter")) {
      this.describing = undefined
      const text = d.input.getValue().trim()
      if (text && text !== d.session.description) void this.describeSession(d.session, text)
    } else {
      d.input.handleInput(data)
    }
    this.tui.requestRender()
  }

  private async describeSession(s: SessionRow, text: string): Promise<void> {
    try {
      await this.deps.describeSession(s.path, text)
    } catch (e) {
      return this.notify(`describe failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    // Rows are shared between the cache and views, so this updates both.
    s.description = text
    this.notify("description set")
    this.refresh()
  }

  private confirmInput(s: SessionRow, data: string): void {
    if (matchesKey(data, "enter") || data === "y" || data === "Y") {
      this.confirmDelete = undefined
      void this.deleteSession(s)
    } else if (matchesKey(data, "escape") || data === "n" || data === "N") {
      this.confirmDelete = undefined
      this.status = ""
    }
    this.tui.requestRender()
  }

  private async deleteSession(s: SessionRow): Promise<void> {
    try {
      const how = await this.deps.deleteSession(s.path)
      const remaining = (await this.sessionsCache ?? []).filter((x) => x.path !== s.path)
      this.sessionsCache = Promise.resolve(remaining)
      for (const v of this.views) {
        if (v.kind === "sessions") v.sessions = v.sessions.filter((x) => x.path !== s.path)
      }
      this.notify(`session ${how}`)
    } catch (e) {
      this.notify(`delete failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    this.refresh()
  }

  private async onLink(): Promise<void> {
    const c = this.actionContext()
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
    return this.height() - 5
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

    const rule = t.fg("border", "─".repeat(width))
    const lines = [this.headerLine(width), this.helpLine(width)]

    if (this.wizard) {
      lines.push(rule, ...this.wizardLines(this.wizard, width, body + 1))
    } else {
      lines.push(this.input.render(width)[0] ?? "", rule)
      lines.push(...this.bodyLines(v, width, body))
    }
    while (lines.length < height - 1) lines.push("")
    const confirm = this.confirmDelete
      ? t.fg("error", `delete session "${this.confirmDelete.description}"? y/enter confirm, n/esc cancel`)
      : ""
    const prompt = this.describing
      ? t.fg("accent", "description: ") + (this.describing.input.render(Math.max(1, width - 13))[0] ?? "").replace(/^> /, "")
      : this.creating
        ? t.fg("accent", `context under ${this.creating.parent.slug}: `) +
          (this.creating.input.render(Math.max(1, width - this.creating.parent.slug.length - 11))[0] ?? "").replace(/^> /, "")
        : ""
    lines.push(confirm || prompt || (this.status ? t.fg("warning", this.status) : ""))
    return lines.slice(0, height).map((l) => truncateToWidth(l, width))
  }

  private bodyLines(v: View, width: number, body: number): string[] {
    const t = this.theme
    const listFor = (w: number, h: number) => v.kind === "contexts"
      ? this.contextLines(v, w, h)
      : v.kind === "sessions"
        ? this.sessionLines(v, w, h)
        : v.kind === "activity"
          ? this.activityLines(v, w, h)
          : v.kind === "log"
            ? this.logLines(v, w, h)
            : this.artifactLines(v, w, h)
    const out: string[] = []
    if (!this.previewShown()) {
      const list = listFor(width, body)
      for (let i = 0; i < body; i++) out.push(pad(list[i] ?? "", width))
    } else if (this.stacked.has(this.view.kind)) {
      const listH = Math.max(3, Math.floor((body - 1) * 0.4))
      const previewH = body - listH - 1
      const list = listFor(width, listH)
      for (let i = 0; i < listH; i++) out.push(pad(list[i] ?? "", width))
      out.push(t.fg("border", "─".repeat(width)))
      out.push(...this.previewLines(width, previewH))
    } else {
      const listWidth = Math.max(40, Math.min(width - 30, Math.floor(width * 0.55)))
      const previewWidth = Math.max(10, width - listWidth - 3)
      const list = listFor(listWidth, body)
      const preview = this.previewLines(previewWidth, body)
      const sep = t.fg("border", " │ ")
      for (let i = 0; i < body; i++) {
        out.push(pad(list[i] ?? "", listWidth) + sep + clip(preview[i] ?? "", previewWidth))
      }
    }
    return out
  }

  private wizardLines(w: Wizard, width: number, height: number): string[] {
    const t = this.theme
    const out = [t.fg("accent", t.bold(`New artifact in ${w.context.address}`)), ""]
    if (w.step === "type") {
      out.push(t.fg("muted", "type:"))
      CREATE_TYPES.forEach((type, i) => {
        const line = pad(`  ${type}`, width)
        out.push(i === w.typeIndex ? t.bg("selectedBg", line) : line)
      })
    } else {
      const type = CREATE_TYPES[w.typeIndex]!
      out.push(t.fg("muted", `type: ${type}`))
      out.push(t.fg("muted", w.asPath ? "path (nesting allowed):" : "slug:"))
      out.push(w.input.render(width)[0] ?? "")
      const name = artifactFilename(w.input.getValue(), w.asPath, type !== "tmp")
      if (name) out.push(t.fg("dim", `  -> ${type}/${name}`))
      if (w.error) out.push(t.fg("error", w.error))
    }
    return out.slice(0, height)
  }

  private scopeTag(): string {
    const k = this.view.kind
    const scoped = this.repoScope && (k === "contexts" || k === "sessions")
    return scoped ? this.theme.fg("warning", " scope:repo") : ""
  }

  private headerLine(width: number): string {
    const t = this.theme
    const v = this.view
    const here = this.deps.sessionAddress()
    const title = v.kind === "contexts"
      ? `Cue contexts ${t.fg("muted", v.recent ? `(recent ${this.recencyDays}d)` : "(all)")}${t.fg("muted", this.contextsFlat ? " flat" : " tree")}${this.showArchived ? t.fg("muted", " +archived") : ""}`
      : v.kind === "sessions"
        ? `Cue sessions ${t.fg("muted", `(${v.subset === "recent" ? `recent ${this.recencyDays}d` : v.subset}) ${!this.sessionsFlat && v.subset !== "labeled" ? "tree" : "flat"}${v.context ? ` ${v.context.address}` : ""}`)}`
        : v.kind === "activity"
          ? `Cue activity ${t.fg("muted", `${v.recent ? `recent ${this.recencyDays}d` : "all"} ${v.context.address}`)}`
          : v.kind === "log"
          ? `Cue log ${t.fg("muted", `${v.recent ? `recent ${this.recencyDays}d` : "all"} ${v.context.address}`)}`
          : `Cue artifacts ${t.fg("muted", v.context.address)}`
    const target = t.fg(this.target === "tmux" ? "warning" : "muted", `[${this.target}]`)
    const right = t.fg("dim", `session: ${here ?? "none"}`)
    const left = t.fg("accent", t.bold(title)) + "  " + target + this.scopeTag()
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right))
    return left + " ".repeat(gap) + right
  }

  private helpLine(width: number): string {
    const v = this.view
    const esc = this.views.length > 1 ? "esc back" : "esc close"
    let hints: string[]
    if (this.wizard) {
      hints = this.wizard.step === "type"
        ? ["up/down type", "enter next", "esc cancel"]
        : ["enter create", "tab slug/path", "esc back"]
    } else if (v.kind === "contexts") {
      hints = ["enter artifacts", "ctrl+r sessions", "ctrl+a activity", "ctrl+g log", "ctrl+e open", "ctrl+t target", "ctrl+n new context",
        "ctrl+s session", "ctrl+l link", "alt+f pin", "alt+s scope", "alt+a archive", "alt+v show archived", "alt+z fold", "alt+t tree/flat", "alt+r reload", "ctrl+h address",
        "ctrl+y path", "ctrl+up/down recency", "tab recent/all", esc]
    } else if (v.kind === "sessions") {
      hints = ["enter resume", "ctrl+a activity", "ctrl+g log", "ctrl+t target", "ctrl+s new session", "ctrl+l link", "ctrl+x delete", "alt+u unlabel", "alt+d describe", "alt+s scope",
        "alt+z fold", "alt+t tree/flat", "ctrl+up/down recency", "tab recent/labeled/all", "ctrl+h address", "ctrl+y path", "alt+r reload", "alt+p preview",
        "alt+l layout", ...this.previewHints(), esc]
    } else if (v.kind === "activity") {
      hints = ["ctrl+g log", "ctrl+r sessions", "tab recent/all", "ctrl+up/down recency", "ctrl+h address",
        "alt+r reload", "alt+p preview", "alt+l layout",
        ...this.previewHints(), esc]
    } else if (v.kind === "log") {
      hints = ["enter/ctrl+e open trace", "ctrl+a activity", "ctrl+r sessions", "ctrl+t target", "tab recent/all", "ctrl+up/down recency",
        "ctrl+y address", "ctrl+h link", "alt+r reload", "alt+p preview", "alt+l layout", ...this.previewHints(), esc]
    } else {
      hints = ["enter open", "ctrl+e open", "ctrl+r sessions", "ctrl+a activity", "ctrl+g log", "ctrl+t target", "ctrl+n new", "ctrl+s session",
        "ctrl+h address", "ctrl+y path", "alt+r reload", "alt+p preview", "alt+l layout",
        ...this.previewHints(), esc]
    }
    return truncateToWidth(this.theme.fg("dim", hints.join(" • ")), width, "…")
  }

  private previewHints(): string[] {
    return this.showPreview ? ["ctrl+d/u scroll", "ctrl+home/end top/bottom"] : []
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
    if (rows.length === 0) {
      return [t.fg("warning", v.recent ? `no contexts active in ${this.recencyDays}d (ctrl+up: widen, tab: all)` : "no contexts")]
    }
    v.selected = Math.min(v.selected, rows.length - 1)
    const tree = !this.contextsFlat && v.query.trim() === ""
    const here = this.deps.sessionAddress()
    const mixed = new Set(rows.map((r) => r.scope)).size > 1
    const hidden = tree ? collapseTree(this.treeRows(v), this.collapsed).hidden : new Map<string, number>()
    const slugWidth = this.slugWidth
    const now = Math.floor(Date.now() / 1000)
    const [a, b] = this.window(rows.length, v.selected, height)
    const out: string[] = []
    for (let i = a; i < b; i++) {
      const r = rows[i]!
      const sel = i === v.selected
      const line = contextLine(t, r, { tree, here, mixed, hidden, slugWidth, now, width })
      out.push(sel ? t.bg("selectedBg", line) : line)
    }
    return out
  }

  private sessionLines(v: SessionsView, width: number, height: number): string[] {
    const t = this.theme
    if (v.loading && v.sessions.length === 0) return [t.fg("dim", "loading…")]
    const rows = this.shownSessions(v)
    if (rows.length === 0) return [t.fg("warning", v.subset === "all" ? "no sessions" : `no ${v.subset} sessions (tab: next)`)]
    v.selected = Math.min(v.selected, rows.length - 1)
    const now = Math.floor(Date.now() / 1000)
    const here = this.deps.sessionAddress()
    const current = this.deps.currentSession()
    const flat = v.subset === "labeled" || this.sessionsFlat || v.query.trim() !== ""
    // Same thresholds as the footer (extensions/footer.ts).
    const tokColor = (tokens: number | null) =>
      tokens == null ? "muted"
        : tokens >= 100_000 ? "error"
          : tokens >= 80_000 ? "warning"
            : "success"
    const right = (s: SessionRow | undefined) => {
      if (!s) return t.fg("muted", " ".repeat(11))
      let tok = t.fg(tokColor(s.tokens), fmtTokens(s.tokens))
      if (s.tokens != null && s.tokens >= 140_000) tok = t.bold(tok)
      tok = " ".repeat(Math.max(0, 6 - visibleWidth(fmtTokens(s.tokens)))) + tok
      return tok + " " + t.fg("muted", relativeAge(s.modified, now).padStart(4))
    }
    const label = (s: SessionRow) => (s.label ? " " + t.fg("error", `[${truncateToWidth(s.label, 12, "…")}]`) : "")
    const nameWidth = Math.max(10, width - 12)
    const [a, b] = this.window(rows.length, v.selected, height)
    const out: string[] = []
    for (let i = a; i < b; i++) {
      const r = rows[i]!
      const sel = i === v.selected
      let name: string
      let tail: SessionRow | undefined
      if (r.kind === "context") {
        const c = r.context
        const pin = c.pinned ? t.fg("warning", "*") : " "
        const slug = c.address === here ? t.fg("accent", c.slug) : c.slug
        const folded = this.sessionFolds?.has(c.address) && r.sessions.length > 0
        const count = r.sessions.length ? t.fg("dim", ` (${r.sessions.length})${folded ? " +" : ""}`) : ""
        name = `${pin} ${"  ".repeat(c.depth)}${r.sessions.length ? slug : t.fg("dim", c.slug)}${count}`
        tail = r.sessions[0]
      } else {
        const s = r.session
        const indent = flat ? "  " : `  ${"  ".repeat(r.context.depth + 1)}`
        const desc = s.path === current ? t.fg("accent", s.description) : s.description
        // Flat rows lead with the context, as the tmux window picker does.
        const where = flat ? t.fg("muted", r.context.slug) + t.fg("dim", " | ") : ""
        name = indent + where + desc + label(s)
        tail = s
      }
      const line = pad(`${pad(name, nameWidth)} ${right(tail)}`, width)
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

  private activityLines(v: ActivityView, width: number, height: number): string[] {
    const t = this.theme
    if (v.loading && v.rows.length === 0) return [t.fg("dim", "loading…")]
    const rows = this.shownActivity(v)
    if (rows.length === 0) {
      return [t.fg("warning", v.recent ? `no activity in ${this.recencyDays}d (ctrl+up: widen, tab: all)` : "no activity")]
    }
    v.selected = Math.min(v.selected, rows.length - 1)
    const now = Date.now()
    // when(11) badge(9) who(13), each followed by a space
    const summaryWidth = Math.max(10, width - (11 + 1) - (9 + 1) - (13 + 1))
    const [a, b] = this.window(rows.length, v.selected, height)
    const out: string[] = []
    for (let i = a; i < b; i++) {
      const e = rows[i]!
      const sel = i === v.selected
      const when = pad(fmtWhen(e.timestamp, now), 11)
      const badge = t.fg(kindLabel(e.kind).color, pad(kindLabel(e.kind).label, 9))
      const who = t.fg("dim", pad(`${e.harness ?? "?"}@${e.host ?? "?"}`, 13))
      const line = pad(`${when} ${badge} ${who} ${pad(eventSummary(e), summaryWidth)}`, width)
      out.push(sel ? t.bg("selectedBg", line) : line)
    }
    return out
  }

  private logLines(v: LogView, width: number, height: number): string[] {
    const t = this.theme
    if (v.loading && v.rows.length === 0) return [t.fg("dim", "loading…")]
    const rows = this.shownLog(v)
    if (rows.length === 0) {
      return [t.fg("warning", v.recent ? `no log entries in ${this.recencyDays}d (ctrl+up: widen, tab: all)` : "no log entries")]
    }
    v.selected = Math.min(v.selected, rows.length - 1)
    const now = Date.now()
    const [a, b] = this.window(rows.length, v.selected, height)
    const out: string[] = []
    for (let i = a; i < b; i++) {
      const e = rows[i]!
      const when = fmtStamp(e.timestamp, now)
      const trace = e.trace ? t.fg("warning", "◆") : " "
      const line = pad(`${when} ${trace} ${e.title}`, width)
      out.push(i === v.selected ? t.bg("selectedBg", line) : line)
    }
    return out
  }

  /** Log preview markdown: the entry, then its linked trace. */
  private logPreviewFor(e: LogEntry): string {
    const p = tracePath(e, this.deps.storeRoot())
    if (!p) return logPreview(e)
    try {
      return logPreview(e, readFileSync(p, "utf8"))
    } catch {
      return logPreview(e, null)
    }
  }

  /** Markdown for the preview: an artifact file or a session transcript. */
  private previewSource(path: string): string {
    let text: string
    try {
      text = readFileSync(path, "utf8")
    } catch {
      return `_cannot read ${path}_`
    }
    if (this.view.kind === "sessions") {
      // The description shows in the list row; no heading in the preview.
      return transcript(text) || "_no messages_"
    }
    return path.endsWith(".md") ? previewMarkdown(text) : "```\n" + text + "\n```"
  }

  /** Activity preview markdown for the selected event. */
  private activityPreview(e: ActivityEvent): string {
    const extras: { gitShow?: string | null; artifact?: string | null; sessionPreview?: string | null } = {}
    if (e.kind === "git_commit") {
      const c = commitDetails(e)
      extras.gitShow = c?.root ? this.deps.gitShow(c.root, c.hash) : null
    } else if (e.kind === "artifact_created") {
      const p = artifactPath(e, this.deps.storeRoot())
      if (p) {
        try {
          extras.artifact = readFileSync(p, "utf8")
        } catch {
          extras.artifact = null
        }
      }
    } else if (e.kind === "session_associated" && e.sessionId) {
      const p = this.deps.sessionFile(e.sessionId)
      if (p) {
        try {
          const text = readFileSync(p, "utf8")
          extras.sessionPreview = transcript(text) || "_no messages_"
        } catch {
          extras.sessionPreview = null
        }
      }
    }
    return eventPreview(e, extras)
  }

  private previewLines(width: number, height: number): string[] {
    const v = this.view
    if (v.kind === "log") {
      const e = this.selectedLog()
      if (!e) return []
      const key = `log:${e.id}`
      if (this.previewCache?.key !== key) {
        this.previewCache = { key, lines: this.renderPreview(this.logPreviewFor(e)) }
      }
      return this.sliceAndClamp(this.previewCache.lines, width, height)
    }
    const selectedEvent = v.kind === "activity" ? this.selectedActivity() : undefined
    const path = v.kind === "sessions" ? this.selectedSession()?.path : this.selectedPath()
    const key = v.kind === "activity"
      ? `activity:${selectedEvent?.id ?? ""}`
      : path!
    if ((v.kind === "activity" ? selectedEvent === undefined : !path)) return []
    if (this.previewCache?.key !== key) {
      const md = v.kind === "activity"
        ? this.activityPreview(selectedEvent!)
        : this.previewSource(path!)
      this.previewCache = { key, lines: this.renderPreview(md) }
    }
    return this.sliceAndClamp(this.previewCache.lines, width, height)
  }

  /**
   * Markdown lines for the preview, unwrapped: rendered at a width no line
   * reaches, then cut to the pane by sliceAndClamp.
   */
  private renderPreview(md: string): string[] {
    const t = this.theme
    // Transcript role lines (`**you**` / `**agent**`) get their own colours.
    return new Markdown(md, 0, 0, getMarkdownTheme()).render(UNWRAPPED_WIDTH).map((l) => {
      // eslint-disable-next-line no-control-regex
      const plain = l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()
      if (plain === "you") return t.bold(t.fg("accent", "you"))
      if (plain === "agent") return t.bold(t.fg("success", "agent"))
      return l
    })
  }

  private sliceAndClamp(lines: string[], width: number, height: number): string[] {
    const max = Math.max(0, lines.length - height)
    this.previewScroll = Math.min(this.previewScroll, max)
    return lines
      .slice(this.previewScroll, this.previewScroll + height)
      .map((l) => clip(l, width))
  }
}
