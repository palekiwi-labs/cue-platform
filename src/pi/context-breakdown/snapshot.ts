import { createHash } from "node:crypto"
import type { ToolDef } from "./entries"

/** Custom entry type carrying a static-prefix snapshot. */
export const SNAPSHOT_TYPE = "context-snapshot"

export type Part = {
  name: string
  chars: number
  hash: string
  items?: Part[]
}

/** Sizes and hashes of the static prompt prefix: system prompt and tools. */
export type Snapshot = {
  v: 1
  hash: string
  model: string | null
  sections: Part[]
  tools: Part[]
  activeTools: string[]
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

function part(name: string, text: string, items?: Part[]): Part {
  return { name, chars: text.length, hash: sha256(text), ...(items && items.length ? { items } : {}) }
}

const OPEN = /^<([A-Za-z][\w-]*)(?:\s[^>]*)?>$/

type Block = { tag: string | null; open: string; text: string }

function splitBlocks(text: string): Block[] {
  const lines = text.split("\n")
  const blocks: Block[] = []
  let loose: string[] = []
  const flushLoose = () => {
    const joined = loose.join("\n").trim()
    if (joined) blocks.push({ tag: null, open: "", text: joined })
    loose = []
  }
  for (let i = 0; i < lines.length; i++) {
    const m = OPEN.exec(lines[i])
    if (m) {
      const close = `</${m[1]}>`
      let j = i + 1
      while (j < lines.length && lines[j] !== close) j++
      if (j < lines.length) {
        flushLoose()
        blocks.push({ tag: m[1], open: lines[i], text: lines.slice(i, j + 1).join("\n") })
        i = j
        continue
      }
    }
    loose.push(lines[i])
  }
  flushLoose()
  return blocks
}

function attr(open: string, name: string): string | null {
  const m = new RegExp(`${name}="([^"]*)"`).exec(open)
  return m ? m[1] : null
}

function itemsOf(tag: string, text: string): Part[] {
  const inner = text.split("\n").slice(1, -1).join("\n")
  if (tag === "project_context") {
    return splitBlocks(inner)
      .filter((b) => b.tag === "project_instructions")
      .map((b) => part(attr(b.open, "path") ?? "project_instructions", b.text))
  }
  if (tag === "skills") {
    const out: Part[] = []
    const re = /<skill>[\s\S]*?<\/skill>/g
    for (const m of inner.matchAll(re)) {
      const name = /<name>([^<]*)<\/name>/.exec(m[0])?.[1]?.trim() ?? "skill"
      out.push(part(name, m[0]))
    }
    return out
  }
  return []
}

/**
 * Split a rendered system prompt into its top-level sections: untagged text
 * and every `<tag ...>...</tag>` block that starts at a line of its own.
 * Project context files and skills are listed as items of their sections.
 */
export function splitSystemPrompt(prompt: string): Part[] {
  const parts: Part[] = []
  const seen = new Map<string, number>()
  const unique = (name: string) => {
    const n = (seen.get(name) ?? 0) + 1
    seen.set(name, n)
    return n === 1 ? name : `${name}#${n}`
  }
  for (const b of splitBlocks(prompt)) {
    const name = unique(b.tag ?? (parts.length === 0 ? "preamble" : "untagged"))
    parts.push(part(name, b.text, b.tag ? itemsOf(b.tag, b.text) : undefined))
  }
  return parts
}

/** The text a tool definition contributes to a request. */
export function toolText(tool: ToolDef): string {
  return JSON.stringify({ name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? {} })
}

/** Build a snapshot from the effective system prompt and declared tools. */
export function buildSnapshot(input: {
  systemPrompt: string
  tools: ToolDef[]
  activeTools?: string[]
  model: string | null
}): Snapshot {
  const sections = splitSystemPrompt(input.systemPrompt)
  const tools = input.tools.map((t) => part(t.name, toolText(t)))
  const activeTools = input.activeTools ?? input.tools.map((t) => t.name)
  const hash = sha256(
    JSON.stringify([input.model, sections.map((s) => s.hash), tools.map((t) => t.hash), activeTools]),
  )
  return { v: 1, hash, model: input.model, sections, tools, activeTools }
}

export function isSnapshot(value: unknown): value is Snapshot {
  const s = value as Snapshot
  return !!s && s.v === 1 && typeof s.hash === "string" && Array.isArray(s.sections) && Array.isArray(s.tools)
}

export type PartChange = {
  name: string
  change: "added" | "removed" | "changed"
  before?: number
  after?: number
  items?: PartChange[]
}

export type SnapshotDiff = {
  same: boolean
  model: { before: string | null; after: string | null } | null
  sections: PartChange[]
  tools: PartChange[]
  activeAdded: string[]
  activeRemoved: string[]
}

function diffParts(a: Part[], b: Part[]): PartChange[] {
  const before = new Map(a.map((p) => [p.name, p]))
  const after = new Map(b.map((p) => [p.name, p]))
  const out: PartChange[] = []
  for (const p of a) {
    const q = after.get(p.name)
    if (!q) out.push({ name: p.name, change: "removed", before: p.chars })
    else if (q.hash !== p.hash) {
      const items = diffParts(p.items ?? [], q.items ?? [])
      out.push({ name: p.name, change: "changed", before: p.chars, after: q.chars, ...(items.length ? { items } : {}) })
    }
  }
  for (const q of b) if (!before.has(q.name)) out.push({ name: q.name, change: "added", after: q.chars })
  return out
}

/** Compare two snapshots: changed sections and tools are cache-bust candidates. */
export function diffSnapshots(a: Snapshot, b: Snapshot): SnapshotDiff {
  const sections = diffParts(a.sections, b.sections)
  const tools = diffParts(a.tools, b.tools)
  const activeAdded = b.activeTools.filter((t) => !a.activeTools.includes(t))
  const activeRemoved = a.activeTools.filter((t) => !b.activeTools.includes(t))
  const model = a.model !== b.model ? { before: a.model, after: b.model } : null
  return {
    same: !model && !sections.length && !tools.length && !activeAdded.length && !activeRemoved.length,
    model,
    sections,
    tools,
    activeAdded,
    activeRemoved,
  }
}
