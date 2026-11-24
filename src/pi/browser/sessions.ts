/**
 * Pure data for the sessions view: one pass over a pi session file
 * (JSONL) for list metadata, the conversation transcript for the
 * preview, and the grouping of sessions under the cue context tree.
 */

import { calculateContextTokens, type Theme } from "@earendil-works/pi-coding-agent"
import { truncateToWidth } from "@earendil-works/pi-tui"
import type { SaturationLevel, Thresholds } from "../lib/context-usage"
import { SESSION_TASK_TYPE, taskContextOf, taskSlug } from "../lib/session-task"
import { ownThresholds } from "../lib/session-thresholds"
import { ALL_TIME_DAYS, type ContextRow } from "./model"

const CUE_CONTEXT_TYPE = "cue-context"
const DESCRIPTION_TYPE = "session-description"

export interface SessionRow {
  path: string
  cwd: string
  /** `<org>/<repo>` of the cwd's git origin, when it has one. */
  cwdScope?: string
  /** Newest cue context linked on the mainline. */
  address?: string
  /** session-description, else session name, else first message. */
  description: string
  /** Newest active native label on the mainline. */
  label?: string
  /** Active task address, valid only while its context is `address`. */
  task?: string
  /** Context size from the last valid assistant usage. */
  tokens: number | null
  /** Saturation level of `tokens` against the session's own thresholds. */
  level?: SaturationLevel
  /** Unix seconds of the last modification. */
  modified: number
}

export interface SessionMeta {
  address?: string
  description?: string
  label?: string
  task?: string
  tokens: number | null
  /** Thresholds set in the session with /thresholds, if any. */
  thresholds?: Thresholds
}

type Entry = Record<string, any>

/** JSON object entries of a session file in file order; malformed lines are skipped. */
export function parseEntries(content: string): Entry[] {
  const entries: Entry[] = []
  for (const line of content.split("\n")) {
    if (!line.trim()) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry && typeof entry === "object") entries.push(entry as Entry)
  }
  return entries
}

/** Mainline of a session file, root first: the tip's parentId chain. */
export function mainline(content: string | Entry[]): Entry[] {
  const byId = new Map<string, Entry>()
  let tip: Entry | undefined
  for (const entry of typeof content === "string" ? parseEntries(content) : content) {
    if (!entry.id) continue
    byId.set(entry.id, entry)
    tip = entry
  }
  const branch: Entry[] = []
  for (let cur = tip; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
    branch.push(cur)
  }
  return branch.reverse()
}

/** List metadata, newest entry winning for each field. */
export function sessionMeta(content: string | Entry[]): SessionMeta {
  const meta: SessionMeta = { tokens: null }
  const labeled = new Set<string>()
  let task: string | null | undefined
  const branch = mainline(content)
  const own = ownThresholds(branch as never)
  if (own) meta.thresholds = own
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!
    if (meta.address === undefined && e.customType === CUE_CONTEXT_TYPE) {
      const payload = e.type === "custom_message" ? e.details : e.type === "custom" ? e.data : undefined
      if (typeof payload?.address === "string" && payload.address !== "") meta.address = payload.address
    }
    if (
      meta.description === undefined && e.customType === DESCRIPTION_TYPE &&
      typeof e.data?.text === "string" && e.data.text.trim() !== ""
    ) {
      meta.description = e.data.text.trim()
    }
    if (task === undefined && e.type === "custom" && e.customType === SESSION_TASK_TYPE) {
      const address = e.data?.address
      task = typeof address === "string" && address !== "" ? address : null
    }
    // For each target the newest label entry wins; one without a label clears it.
    if (e.type === "label" && !labeled.has(e.targetId)) {
      labeled.add(e.targetId)
      if (meta.label === undefined && typeof e.label === "string" && e.label !== "") meta.label = e.label
    }
    const msg = e.type === "message" ? e.message : undefined
    if (
      meta.tokens === null && msg?.role === "assistant" && msg.usage &&
      msg.stopReason !== "aborted" && msg.stopReason !== "error"
    ) {
      const tokens = calculateContextTokens(msg.usage)
      if (tokens > 0) meta.tokens = tokens
    }
  }
  if (task && meta.address !== undefined && taskContextOf(task) === meta.address) meta.task = task
  return meta
}

const textOf = (content: unknown, sep = "\n\n"): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join(sep)
}

/** What one parse of a session file gives the sessions list. */
export interface ParsedSession {
  cwd: string
  /** Newest session_info name in the file; an empty name clears it. */
  name?: string
  /** Text of the first user message with text, or "". */
  firstMessage: string
  /**
   * Epoch milliseconds of the newest user or assistant message, else of
   * the header; undefined when neither is known (callers use the mtime).
   */
  modified?: number
  meta: SessionMeta
}

/**
 * Everything the sessions list needs from one session file, in a single
 * parse. Name, first message and modified time follow pi's own session
 * list; null when the file does not start with a session header.
 */
export function parseSession(content: string): ParsedSession | null {
  const entries = parseEntries(content)
  const header = entries[0]
  if (header?.type !== "session") return null
  let name: string | undefined
  let firstMessage = ""
  let lastActivity: number | undefined
  for (let i = 1; i < entries.length; i++) {
    const e = entries[i]!
    if (e.type === "session_info") name = typeof e.name === "string" ? e.name.trim() || undefined : undefined
    if (e.type !== "message") continue
    const m = e.message
    if (typeof m?.role !== "string" || !("content" in m)) continue
    if (m.role !== "user" && m.role !== "assistant") continue
    const time = typeof m.timestamp === "number" ? m.timestamp : new Date(e.timestamp).getTime()
    if (!Number.isNaN(time)) lastActivity = Math.max(lastActivity ?? 0, time)
    if (!firstMessage && m.role === "user") firstMessage = textOf(m.content, " ")
  }
  const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN
  const modified = lastActivity !== undefined && lastActivity > 0
    ? lastActivity
    : Number.isNaN(headerTime) ? undefined : headerTime
  return {
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    name,
    firstMessage,
    modified,
    meta: sessionMeta(entries),
  }
}

/** Description of a session without a session-description: its name, else first message. */
export function fallbackDescription(name: string | undefined, firstMessage: string): string {
  return (name || firstMessage || "(no messages)").replace(/\s+/g, " ").slice(0, 80)
}

/**
 * Markdown record of the conversation: the description, then every user
 * and assistant text in mainline order. Tool calls, tool results and
 * thinking are left out.
 */
export function transcript(content: string, description?: string): string {
  const parts: string[] = []
  if (description) parts.push(`# ${description}`)
  for (const e of mainline(content)) {
    if (e.type !== "message") continue
    const role = e.message?.role
    if (role !== "user" && role !== "assistant") continue
    const text = textOf(e.message.content).trim()
    if (text === "") continue
    parts.push(`**${role === "user" ? "you" : "agent"}**\n\n${text}`)
  }
  return parts.join("\n\n---\n\n")
}

/** `<org>/<repo>` of a canonical address. */
export function scopeOf(address: string): string {
  return address.split("/").slice(0, 2).join("/")
}

export function fmtTokens(tokens: number | null): string {
  if (tokens === null) return "-"
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`
}

/** Group key and header for sessions without a cue context. */
export const NO_CONTEXT = ""

export type SessionListRow =
  | {
      kind: "context"
      context: ContextRow
      /** Direct sessions, newest first. */
      sessions: SessionRow[]
    }
  | { kind: "session"; session: SessionRow; context: ContextRow }

export function syntheticContext(address: string): ContextRow {
  const slug = address === NO_CONTEXT ? "(no context)" : address.split("/").pop() ?? address
  return {
    address, scope: address === NO_CONTEXT ? "" : scopeOf(address), slug, title: slug,
    mode: null, kind: null, pinned: false, lastLoggedAt: null, createdAt: null, archivedAt: null, path: "",
    depth: 0, connectors: [], isLast: true,
  }
}

/**
 * Sessions grouped under the context tree. A context row stays when it
 * or a descendant has sessions; its own sessions follow it directly,
 * before child contexts. Folded contexts hide only their own sessions.
 * With `orphans`, sessions whose context is not in the tree get
 * top-level groups after it, and sessions without a context come last.
 */
export function groupSessions(
  contexts: ContextRow[],
  sessions: SessionRow[],
  folded: ReadonlySet<string>,
  orphans: boolean,
): SessionListRow[] {
  const byAddress = new Map<string, SessionRow[]>()
  for (const s of [...sessions].sort((a, b) => b.modified - a.modified)) {
    const key = s.address ?? NO_CONTEXT
    const list = byAddress.get(key)
    if (list) list.push(s)
    else byAddress.set(key, [s])
  }
  // A context is kept when any row of its subtree has sessions.
  const keep = new Array<boolean>(contexts.length).fill(false)
  for (let i = contexts.length - 1; i >= 0; i--) {
    const c = contexts[i]!
    let any = byAddress.has(c.address)
    for (let j = i + 1; j < contexts.length && contexts[j]!.depth > c.depth; j++) {
      if (keep[j]) {
        any = true
        break
      }
    }
    keep[i] = any
  }
  const out: SessionListRow[] = []
  const push = (context: ContextRow, list: SessionRow[]) => {
    out.push({ kind: "context", context, sessions: list })
    if (folded.has(context.address)) return
    for (const session of list) out.push({ kind: "session", session, context })
  }
  const inTree = new Set<string>()
  contexts.forEach((c, i) => {
    inTree.add(c.address)
    if (keep[i]) push(c, byAddress.get(c.address) ?? [])
  })
  if (!orphans) return out
  for (const [address, list] of byAddress) {
    if (address !== NO_CONTEXT && !inTree.has(address)) push(syntheticContext(address), list)
  }
  const none = byAddress.get(NO_CONTEXT)
  if (none) push(syntheticContext(NO_CONTEXT), none)
  return out
}

/**
 * Grouped rows flattened to one level: a heading per context that has
 * sessions, its sessions beneath it. Groups are ordered by their newest
 * session; sessions without a context come last.
 */
export function contextGroups(rows: SessionListRow[]): SessionListRow[] {
  const groups = rows
    .flatMap((r) => (r.kind === "context" && r.sessions.length > 0 ? [r] : []))
    .map((r) => ({ ...r, context: { ...r.context, depth: 0, connectors: [] } }))
    .sort((a, b) =>
      Number(a.context.address === NO_CONTEXT) - Number(b.context.address === NO_CONTEXT) ||
      b.sessions[0]!.modified - a.sessions[0]!.modified)
  const shown = new Set(rows.flatMap((r) => (r.kind === "session" ? [r.session.path] : [])))
  return groups.flatMap((g) => [
    g as SessionListRow,
    ...g.sessions.filter((s) => shown.has(s.path)).map((session) => ({ kind: "session" as const, session, context: g.context })),
  ])
}

/** A session's task column: the active task slug, or `(no active task)`. */
export function taskText(task: string | undefined): string {
  return task ? taskSlug(task) : "(no active task)"
}

/**
 * The `(org/repo)` marker of a session in another project than the
 * current session (`here`: its cwd and that cwd's repo). Repos compare by
 * scope, so worktrees of one repo count as the same project; cwds without
 * a repo compare by path. `mismatch` when the cwd repo is not the scope
 * of the session's own context: the session was created in another repo,
 * and resuming it moves pi there. Mismatches always show.
 */
export function cwdMark(
  s: Pick<SessionRow, "cwd" | "cwdScope" | "address">,
  here: { cwd: string; scope?: string },
): { text: string; mismatch: boolean } | undefined {
  if (!s.cwd) return undefined
  const mismatch = s.address !== undefined && s.cwdScope !== undefined && s.cwdScope !== scopeOf(s.address)
  const same = s.cwdScope !== undefined && here.scope !== undefined ? s.cwdScope === here.scope : s.cwd === here.cwd
  if (!mismatch && same) return undefined
  const name = s.cwdScope ?? s.cwd.split("/").filter(Boolean).pop() ?? s.cwd
  return { text: `(${name})`, mismatch }
}

/** `<org>/<repo>` of a git remote URL (https, ssh or scp form). */
export function scopeOfRemote(url: string): string | undefined {
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : undefined
}

/**
 * Sessions belonging to the browser's scopes: by the linked context's
 * scope, or, without a context, by the scope of the session's cwd.
 */
export function inScopes(
  sessions: SessionRow[],
  scopes: ReadonlySet<string>,
  cwdScope: (cwd: string) => string | undefined,
): SessionRow[] {
  return sessions.filter((s) => {
    const scope = s.address ? scopeOf(s.address) : s.cwd ? cwdScope(s.cwd) : undefined
    return scope !== undefined && scopes.has(scope)
  })
}

/**
 * The sessions view's default listing flattened: sessions of the context
 * tree modified within `days`, newest first, at most `limit`.
 */
export function recentSessions(
  contexts: ContextRow[],
  sessions: SessionRow[],
  now: number,
  days: number,
  limit: number,
): { session: SessionRow; context: ContextRow }[] {
  const since = days === ALL_TIME_DAYS ? -Infinity : now - days * 86400
  return groupSessions(contexts, sessions, new Set(), false)
    .flatMap((r) => (r.kind === "session" && r.session.modified >= since ? [r] : []))
    .sort((a, b) => b.session.modified - a.session.modified)
    .slice(0, limit)
    .map(({ session, context }) => ({ session, context }))
}

/**
 * A flat session row's text: `context / task | description [label]`;
 * the task is left out when none is active, and the description is
 * dropped when it repeats the context.
 */
export function sessionHeadline(
  t: Theme,
  where: string,
  description: string,
  label?: string,
  current = false,
  task?: string,
): string {
  const tag = label ? " " + t.fg("error", `[${truncateToWidth(label, 12, "…")}]`) : ""
  const style = (s: string) => (current ? t.fg("accent", s) : s)
  if (task) where = `${where} / ${taskSlug(task)}`
  if (description === where) return style(where) + tag
  return style(where) + t.fg("dim", ` | ${description}`) + tag
}
