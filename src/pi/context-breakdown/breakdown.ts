import {
  branchPath,
  contextEntries,
  type Content,
  type Entry,
  isAssistant,
  type Message,
  promptTokens,
  replaySystem,
  type ToolDef,
} from "./entries"
import { buildSnapshot, isSnapshot, type Part, SNAPSHOT_TYPE, type Snapshot } from "./snapshot"

const IMAGE_CHARS = 4800

/** Best-effort token estimate, the chars/4 heuristic pi uses. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

export type Group = "system" | "tools" | "messages"

export type Item = { name: string; chars: number; tokens: number; scaled: number }

export type Source = {
  key: string
  label: string
  group: Group
  chars: number
  tokens: number
  scaled: number
  share: number
  count: number
  items: Item[]
}

export type PrefixOrigin = "snapshot" | "transcript" | "live" | "unknown"

export type Breakdown = {
  sources: Source[]
  estimate: number
  exact: number | null
  scale: number
  totals: Record<Group, { tokens: number; scaled: number }>
  trailing: number
  prefix: PrefixOrigin
  snapshot: Snapshot | null
  model: string | null
}

function contentChars(content: Content): number {
  if (content == null) return 0
  if (typeof content === "string") return content.length
  let n = 0
  for (const b of content) {
    if (b.type === "text" && b.text) n += b.text.length
    else if (b.type === "image") n += IMAGE_CHARS
  }
  return n
}

class Acc {
  private map = new Map<string, { label: string; group: Group; chars: number; count: number; items: Map<string, number> }>()

  add(key: string, label: string, group: Group, chars: number, item?: string): void {
    let s = this.map.get(key)
    if (!s) {
      s = { label, group, chars: 0, count: 0, items: new Map() }
      this.map.set(key, s)
    }
    s.chars += chars
    s.count += 1
    if (item !== undefined) s.items.set(item, (s.items.get(item) ?? 0) + chars)
  }

  sources(scale: number, total: number): Source[] {
    const out: Source[] = []
    for (const [key, s] of this.map) {
      const tokens = estimateTokens(s.chars)
      const items = [...s.items]
        .map(([name, chars]) => ({ name, chars, tokens: estimateTokens(chars), scaled: Math.round(estimateTokens(chars) * scale) }))
        .sort((a, b) => b.chars - a.chars)
      out.push({
        key,
        label: s.label,
        group: s.group,
        chars: s.chars,
        tokens,
        scaled: Math.round(tokens * scale),
        share: total > 0 ? tokens / total : 0,
        count: s.count,
        items,
      })
    }
    return out.sort((a, b) => b.tokens - a.tokens)
  }
}

const SECTION_LABELS: Record<string, string> = {
  preamble: "system: preamble",
  tools: "system: tool snippets",
  rules: "system: rules/guidelines",
  docs: "system: pi docs pointer",
  addendum: "system: addendum",
  project_context: "system: project context files",
  skills: "system: skills index",
  cwd: "system: cwd",
  "cue-skill": "system: cue skill injection",
  "cue-session-state": "system: cue session state",
  response_style: "system: response style",
}

function addPrefix(acc: Acc, snap: Snapshot): void {
  for (const s of snap.sections) {
    const base = s.name.replace(/#\d+$/, "")
    const label = SECTION_LABELS[base] ?? `system: ${base}`
    if (s.items && s.items.length) {
      const inItems = s.items.reduce((n, i) => n + i.chars, 0)
      for (const i of s.items) acc.add(`system:${base}`, label, "system", i.chars, i.name)
      const rest = s.chars - inItems
      if (rest > 0) acc.add(`system:${base}`, label, "system", rest, "(wrapper)")
    } else {
      acc.add(`system:${base}`, label, "system", s.chars)
    }
  }
  for (const t of snap.tools) acc.add("tools", "tool definitions", "tools", t.chars, t.name)
}

function addMessage(acc: Acc, m: Message): void {
  switch (m.role) {
    case "user":
      acc.add("user", "user messages", "messages", contentChars(m.content))
      return
    case "assistant": {
      if (!Array.isArray(m.content)) return
      for (const b of m.content) {
        if (b.type === "text") acc.add("assistant:text", "assistant text", "messages", b.text?.length ?? 0)
        else if (b.type === "thinking") acc.add("assistant:thinking", "assistant thinking", "messages", b.thinking?.length ?? 0)
        else if (b.type === "toolCall") {
          const chars = (b.name?.length ?? 0) + JSON.stringify(b.arguments ?? {}).length
          acc.add("assistant:toolCall", "tool calls", "messages", chars, b.name ?? "?")
        }
      }
      return
    }
    case "toolResult":
      acc.add("toolResult", "tool results", "messages", contentChars(m.content), m.toolName ?? "?")
      return
    case "custom":
      acc.add(`custom:${m.customType}`, `injected: ${m.customType}`, "messages", contentChars(m.content))
      return
    case "bashExecution":
      acc.add("bash", "user bash (!)", "messages", (m.command?.length ?? 0) + (m.output?.length ?? 0))
      return
    case "system": {
      let chars = contentChars(m.content)
      for (const v of Object.values(m.sections ?? {})) if (v) chars += v.length
      if (m.toolsAdded?.length) chars += JSON.stringify(m.toolsAdded).length
      acc.add("system-update", "system/tool updates (mid-conversation)", "messages", chars)
      return
    }
  }
}

function withEdit(m: Message, edit: Entry | undefined): Message | null {
  if (!edit) return m
  if (edit.replacement === null || edit.replacement === undefined) return null
  return { ...m, content: edit.replacement.content }
}

/** Messages each context entry contributes, with context edits applied. */
function entryMessages(e: Entry, index: number, edits: Map<string, Entry>): Message[] {
  const edit = edits.get(e.id)
  if (e.type === "message" && e.message) {
    const m = withEdit(e.message, edit)
    return m ? [m] : []
  }
  if (e.type === "custom_message") {
    const m = withEdit({ role: "custom", customType: e.customType, content: e.content }, edit)
    return m ? [m] : []
  }
  if (e.type === "branch_summary" && e.summary) return [{ role: "branchSummary", summary: e.summary }]
  if (e.type === "compaction" && index === 0) {
    const out: Message[] = []
    if (e.systemMessage) out.push(e.systemMessage)
    out.push({ role: "compactionSummary", summary: e.summary ?? "" })
    return out
  }
  return []
}

/** The latest snapshot entry on the path, at or before `limit` (an index). */
export function latestSnapshot(path: Entry[], limit = path.length - 1): Snapshot | null {
  for (let i = Math.min(limit, path.length - 1); i >= 0; i--) {
    const e = path[i]
    if (e.type === "custom" && e.customType === SNAPSHOT_TYPE && isSnapshot(e.data)) return e.data
  }
  return null
}

function modelOf(e: Entry | undefined): string | null {
  const m = e?.message
  return m?.provider && m?.model ? `${m.provider}/${m.model}` : null
}

/**
 * A snapshot rebuilt from the system messages pi records in the
 * transcript. `leadingOnly` keeps the first one (the request's leading
 * system prompt and tools); otherwise all updates are replayed. Prompt text
 * forced by before_agent_start handlers is not recorded and is missing.
 */
export function transcriptSnapshot(path: Entry[], model: string | null, leadingOnly = false): Snapshot | null {
  const system = leadingOnly ? leadingSystem(path) : path
  const { content, sections, tools, found } = replaySystem(system)
  if (!found) return null
  const prompt = [content.join("\n\n"), ...Object.values(sections)].filter((s) => s.length > 0).join("\n\n")
  return buildSnapshot({ systemPrompt: prompt, tools: tools as ToolDef[], model })
}

function leadingSystem(path: Entry[]): Entry[] {
  for (const e of contextEntries(path)) {
    if (e.type === "compaction" && e.systemMessage) return [e]
    if (e.type === "message" && e.message?.role === "system") return [e]
  }
  return []
}

/**
 * Break a session's context down by source.
 *
 * The context measured is the one sent with the last assistant request:
 * everything on the active branch before that message. The chars/4
 * estimate is scaled so it sums to that request's exact prompt total
 * (input + cacheRead + cacheWrite). Content after the last assistant
 * message is reported separately as `trailing` (unscaled).
 *
 * The static prefix comes from the latest `context-snapshot` entry, else
 * `live`, else the leading system message recorded in the transcript.
 */
export function analyseBreakdown(entries: Entry[], live?: Snapshot | null): Breakdown {
  const path = branchPath(entries)
  let lastIdx = -1
  for (let i = path.length - 1; i >= 0; i--) {
    const m = path[i].message
    if (isAssistant(path[i]) && m?.usage && promptTokens(m.usage) > 0) {
      lastIdx = i
      break
    }
  }
  const measured = lastIdx >= 0 ? path.slice(0, lastIdx) : path
  const trailingEntries = lastIdx >= 0 ? path.slice(lastIdx) : []
  const last = lastIdx >= 0 ? path[lastIdx] : undefined
  const exact = last?.message?.usage ? promptTokens(last.message.usage) : null
  const model = modelOf(last)

  let snapshot = latestSnapshot(path, lastIdx >= 0 ? lastIdx : path.length - 1)
  let prefix: PrefixOrigin = "snapshot"
  if (!snapshot && live) {
    snapshot = live
    prefix = "live"
  }
  if (!snapshot) {
    snapshot = transcriptSnapshot(measured.length ? measured : path, model, true)
    prefix = "transcript"
  }
  if (!snapshot) prefix = "unknown"

  const acc = new Acc()
  if (snapshot) addPrefix(acc, snapshot)

  const ctx = contextEntries(measured)
  const edits = new Map<string, Entry>()
  for (const e of ctx) if (e.type === "context_edit" && e.targetId) edits.set(e.targetId, e)
  let seenSystem = false
  ctx.forEach((e, i) => {
    for (const m of entryMessages(e, i, edits)) {
      if (m.role === "system") {
        if (!seenSystem) {
          seenSystem = true
          continue
        }
      }
      if (m.role === "compactionSummary") acc.add("compaction", "compaction summary", "messages", m.summary?.length ?? 0)
      else if (m.role === "branchSummary") acc.add("branch-summary", "branch summary", "messages", m.summary?.length ?? 0)
      else addMessage(acc, m)
    }
  })

  const draft = acc.sources(1, 1)
  const estimate = draft.reduce((n, s) => n + s.tokens, 0)
  const scale = exact !== null && estimate > 0 ? exact / estimate : 1
  const sources = acc.sources(scale, estimate)

  const trailingAcc = new Acc()
  for (const e of trailingEntries) for (const m of entryMessages(e, 1, edits)) addMessage(trailingAcc, m)
  const trailing = trailingAcc.sources(1, 1).reduce((n, s) => n + s.tokens, 0)

  const totals: Record<Group, { tokens: number; scaled: number }> = {
    system: { tokens: 0, scaled: 0 },
    tools: { tokens: 0, scaled: 0 },
    messages: { tokens: 0, scaled: 0 },
  }
  for (const s of sources) {
    totals[s.group].tokens += s.tokens
    totals[s.group].scaled += s.scaled
  }
  return { sources, estimate, exact, scale, totals, trailing, prefix, snapshot, model }
}

export type { Part }
