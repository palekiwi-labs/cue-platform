export type ContentBlock = {
  type: string
  text?: string
  thinking?: string
  name?: string
  arguments?: unknown
}

export type Content = string | ContentBlock[] | null | undefined

export type Usage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens?: number
}

export type ToolDef = {
  name: string
  description?: string
  parameters?: unknown
}

export type Message = {
  role: string
  content?: Content
  timestamp?: number
  provider?: string
  model?: string
  usage?: Usage
  stopReason?: string
  toolName?: string
  command?: string
  output?: string
  summary?: string
  customType?: string
  sections?: Record<string, string | null>
  toolsAdded?: ToolDef[]
  toolsRemoved?: ToolDef[]
}

export type Entry = {
  type: string
  id: string
  parentId: string | null
  timestamp: string
  message?: Message
  customType?: string
  content?: Content
  data?: unknown
  summary?: string
  firstKeptEntryId?: string
  tokensBefore?: number
  systemMessage?: Message
  targetId?: string
  replacement?: { content: Content } | null
  provider?: string
  model?: string
  modelId?: string
  kind?: string
  usage?: Usage
}

export type SessionHeader = {
  type: "session"
  id: string
  timestamp: string
  cwd: string
  version?: number
}

export type ParsedSession = {
  header: SessionHeader | null
  entries: Entry[]
}

/** Parse a pi session JSONL file into its header and entries. */
export function parseSessionJsonl(text: string): ParsedSession {
  let header: SessionHeader | null = null
  const entries: Entry[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (!obj || typeof obj !== "object") continue
    const rec = obj as Entry | SessionHeader
    if (rec.type === "session") header = rec as SessionHeader
    else if (typeof (rec as Entry).id === "string") entries.push(rec as Entry)
  }
  return { header, entries }
}

/** Entries from the root to the leaf (the last entry), following parentId. */
export function branchPath(entries: Entry[]): Entry[] {
  const leaf = entries[entries.length - 1]
  if (!leaf) return []
  const byId = new Map(entries.map((e) => [e.id, e]))
  const path: Entry[] = []
  const seen = new Set<string>()
  let cur: Entry | undefined = leaf
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    path.push(cur)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return path.reverse()
}

/**
 * The compaction-aware entries that make up the model context, mirroring
 * pi's buildContextEntries: the latest compaction, the kept entries before
 * it (system messages excluded), then everything after it.
 */
export function contextEntries(path: Entry[]): Entry[] {
  let idx = -1
  for (let i = 0; i < path.length; i++) if (path[i].type === "compaction") idx = i
  if (idx < 0) return path
  const compaction = path[idx]
  const out: Entry[] = [compaction]
  let kept = false
  for (let i = 0; i < idx; i++) {
    const e = path[i]
    if (e.id === compaction.firstKeptEntryId) kept = true
    if (kept && !(e.type === "message" && e.message?.role === "system")) out.push(e)
  }
  out.push(...path.slice(idx + 1))
  return out
}

export function isAssistant(e: Entry): boolean {
  return e.type === "message" && e.message?.role === "assistant"
}

export function promptTokens(u: Usage): number {
  return u.input + u.cacheRead + u.cacheWrite
}

function textOf(content: Content): string {
  if (content == null) return ""
  if (typeof content === "string") return content
  return content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("")
}

/**
 * Replay recorded system messages into the current prompt and tools, as
 * pi's getCurrentSystemMessage does: content is appended, sections are
 * patched by name, tools are added and removed.
 */
export function replaySystem(path: Entry[]): {
  content: string[]
  sections: Record<string, string>
  tools: ToolDef[]
  found: boolean
} {
  const content: string[] = []
  const sections = new Map<string, string>()
  const tools = new Map<string, ToolDef>()
  let found = false
  const apply = (m: Message) => {
    found = true
    const text = textOf(m.content)
    if (text.length > 0) content.push(text)
    for (const [k, v] of Object.entries(m.sections ?? {})) {
      if (v === null) sections.delete(k)
      else sections.set(k, v)
    }
    for (const t of m.toolsRemoved ?? []) tools.delete(t.name)
    for (const t of m.toolsAdded ?? []) tools.set(t.name, t)
  }
  for (const e of path) {
    if (e.type === "message" && e.message?.role === "system") apply(e.message)
    else if (e.type === "compaction" && e.systemMessage) apply(e.systemMessage)
  }
  return { content, sections: Object.fromEntries(sections), tools: [...tools.values()], found }
}
