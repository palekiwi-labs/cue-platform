/**
 * Pure data for the sessions view: one pass over a pi session file
 * (JSONL) for list metadata, the conversation transcript for the
 * preview, and the grouping of sessions under the cue context tree.
 */

import { calculateContextTokens } from "@earendil-works/pi-coding-agent"
import type { ContextRow } from "./model"

const CUE_CONTEXT_TYPE = "cue-context"
const DESCRIPTION_TYPE = "session-description"

export interface SessionRow {
  path: string
  cwd: string
  /** Newest cue context linked on the mainline. */
  address?: string
  /** session-description, else session name, else first message. */
  description: string
  /** Newest active native label on the mainline. */
  label?: string
  /** Context size from the last valid assistant usage. */
  tokens: number | null
  /** Unix seconds of the last modification. */
  modified: number
}

export interface SessionMeta {
  address?: string
  description?: string
  label?: string
  tokens: number | null
}

type Entry = Record<string, any>

/** Mainline of a session file, root first: the tip's parentId chain. */
export function mainline(content: string): Entry[] {
  const byId = new Map<string, Entry>()
  let tip: Entry | undefined
  for (const line of content.split("\n")) {
    if (!line) continue
    let entry: Entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!entry?.id) continue
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
export function sessionMeta(content: string): SessionMeta {
  const meta: SessionMeta = { tokens: null }
  const labeled = new Set<string>()
  const branch = mainline(content)
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
  return meta
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n\n")
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
    mode: null, kind: null, pinned: false, lastLoggedAt: null, createdAt: null, path: "",
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
