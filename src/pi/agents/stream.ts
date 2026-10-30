/**
 * Pure model of a run's events.jsonl as an activity timeline: turn
 * separators, one row per tool call, collapsed assistant text. The
 * monitor renders the segments; nothing here touches the filesystem
 * or the theme.
 */

import { fmtCost, fmtTokens } from "./model"

export type SegTone = "live" | "ok" | "bad" | "dim" | "muted" | "accent" | "border"

export interface Seg {
  text: string
  tone: SegTone
}

export interface TurnItem {
  kind: "turn"
  index: number
  inTokens: number | null
  outTokens: number | null
  costUsd: number | null
}

export interface ThinkingItem {
  kind: "thinking"
  chars: number
  done: boolean
}

export interface TextItem {
  kind: "text"
  head: string
  chars: number
  done: boolean
}

export interface ComposingItem {
  kind: "composing"
  id: string
  name: string
  chars: number
}

export type ToolState = "pending" | "ok" | "error"

export interface ToolItem {
  kind: "tool"
  id: string
  name: string
  summary: string
  state: ToolState
  detail: string | null
  ms: number | null
}

export interface NoticeItem {
  kind: "notice"
  text: string
  tone: SegTone
}

export type StreamItem = TurnItem | ThinkingItem | TextItem | ComposingItem | ToolItem | NoticeItem

export interface StreamState {
  items: StreamItem[]
  /** Session start from the session event, if seen. */
  startedAt: number | null
  /** Lines that were not JSON and were skipped. */
  skipped: number
  turn: number
  /** Live items by toolCallId, so splices never desync them. */
  toolAt: Map<string, ToolItem>
  textAt: TextItem | null
  thinkAt: ThinkingItem | null
}

const TEXT_HEAD = 160

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null

const str = (v: unknown): string | null => (typeof v === "string" ? v : null)
const num = (v: unknown): number | null => (typeof v === "number" ? v : null)

export function createStream(): StreamState {
  return { items: [], startedAt: null, skipped: 0, turn: 0, toolAt: new Map(), textAt: null, thinkAt: null }
}
/** Replay a whole events.jsonl; the tailer feeds lines one at a time. */
export function parseStream(text: string): StreamState {
  const s = createStream()
  for (const line of text.split("\n")) {
    if (line.trim()) feedLine(s, line)
  }
  return s
}

/** One-line summary of a tool call's arguments; never the raw content. */
export function summarizeArgs(tool: string, args: unknown): string {
  const a = obj(args) ?? {}
  const s = (k: string): string | undefined => {
    const v = a[k]
    return typeof v === "string" || typeof v === "number" ? String(v) : undefined
  }
  const firstLine = (k: string): string | undefined => s(k)?.split("\n")[0]
  const range = (): string => {
    const off = s("offset")
    const lim = s("limit")
    return off !== undefined ? `@${off}${lim !== undefined ? `+${lim}` : ""}` : ""
  }
  switch (tool) {
    case "read":
      return [s("path"), range()].filter(Boolean).join(" ")
    case "bash":
      return firstLine("command") ?? ""
    case "grep":
      return [`/${s("pattern")}/`, s("path")].filter(Boolean).join(" ")
    case "find":
      return [s("pattern"), s("path") ? `in ${s("path")}` : undefined].filter(Boolean).join(" ")
    case "ls":
      return s("path") ?? ""
    case "edit": {
      const edits = a.edits
      const n = Array.isArray(edits) ? edits.length : null
      return [s("path"), n !== null ? `(${n} edits)` : undefined].filter(Boolean).join(" ")
    }
    case "write":
      return [s("path"), s("content") !== undefined ? `(${s("content")!.length} chars)` : undefined]
        .filter(Boolean)
        .join(" ")
    case "delegate": {
      const tasks = Array.isArray(a.tasks) ? a.tasks : []
      const who = tasks
        .map((t) => {
          const task = obj(t)
          if (!task) return "?"
          const model = str(task.model)
          return `${str(task.agent) ?? "?"}${model ? `@${model}` : ""}`
        })
        .join(", ")
      return [`${tasks.length} tasks:`, who].filter(Boolean).join(" ")
    }
    case "cue-log":
      return [s("context"), s("title")].filter(Boolean).join(": ")
    case "cue-add":
    case "cue-plan":
    case "cue-task":
    case "cue-review":
      return [s("context"), s("filename")].filter(Boolean).join(" ")
    default: {
      const parts: string[] = []
      for (const [k, v] of Object.entries(a)) {
        if (parts.length >= 2) break
        if (typeof v === "string" || typeof v === "number") parts.push(`${k}=${String(v).split("\n")[0]}`)
      }
      return parts.join(" ") || ""
    }
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((p) => {
      const part = obj(p)
      return part && typeof part.text === "string" ? part.text : ""
    })
    .join("\n")
}

function firstLine(text: string, max = 80): string {
  return text.trim().split("\n")[0]?.slice(0, max) ?? ""
}

function currentText(s: StreamState): TextItem | null {
  const it = s.textAt
  return it && s.items.includes(it) ? it : null
}

function lastTurn(s: StreamState): TurnItem | null {
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i]!
    if (it.kind === "turn") return it
  }
  return null
}

export function feedLine(s: StreamState, line: string): void {
  let e: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(line)
    e = obj(parsed)!
  } catch {
    s.skipped++
    return
  }
  const push = (item: StreamItem): number => {
    s.items.push(item)
    return s.items.length - 1
  }
  switch (e.type) {
    case "session": {
      const ts = Date.parse(str(e.timestamp) ?? "")
      if (!Number.isNaN(ts)) s.startedAt = ts
      break
    }
    case "turn_start":
      s.turn++
      push({ kind: "turn", index: s.turn, inTokens: null, outTokens: null, costUsd: null })
      break
    case "message_update": {
      const ev = obj(e.assistantMessageEvent)
      if (!ev) break
      if (ev.type === "text_start") {
        s.textAt = { kind: "text", head: "", chars: 0, done: false }
        push(s.textAt)
      } else if (ev.type === "text_delta") {
        const d = typeof ev.delta === "string" ? ev.delta : ""
        let it = currentText(s)
        if (!it || it.done) {
          s.textAt = { kind: "text", head: "", chars: 0, done: false }
          push(s.textAt)
          it = s.textAt
        }
        it.chars += d.length
        if (it.head.length < TEXT_HEAD) it.head = (it.head + d).slice(0, TEXT_HEAD)
      } else if (ev.type === "text_end") {
        const it = currentText(s)
        if (it) it.done = true
      } else if (ev.type === "thinking_start") {
        s.thinkAt = { kind: "thinking", chars: 0, done: false }
        push(s.thinkAt)
      } else if (ev.type === "thinking_delta") {
        const d = typeof ev.delta === "string" ? ev.delta : ""
        const it = s.thinkAt
        if (it && s.items.includes(it) && !it.done) it.chars += d.length
      } else if (ev.type === "thinking_end") {
        const it = s.thinkAt
        if (it && s.items.includes(it)) it.done = true
      } else if (ev.type === "toolcall_start") {
        push({ kind: "composing", id: str(ev.id) ?? "", name: str(ev.toolName) ?? "?", chars: 0 })
      } else if (ev.type === "toolcall_delta") {
        const d = typeof ev.delta === "string" ? ev.delta.length : 0
        for (let i = s.items.length - 1; i >= 0; i--) {
          const it = s.items[i]!
          if (it.kind === "composing") {
            it.chars += d
            break
          }
        }
      }
      break
    }
    case "tool_execution_start": {
      const id = str(e.toolCallId) ?? ""
      const name = str(e.toolName) ?? "?"
      const ci = s.items.findIndex((it) => it.kind === "composing" && it.id === id)
      if (ci >= 0) s.items.splice(ci, 1)
      const tool: ToolItem = { kind: "tool", id, name, summary: summarizeArgs(name, e.args), state: "pending", detail: null, ms: null }
      s.toolAt.set(id, tool)
      push(tool)
      break
    }
    case "tool_execution_end": {
      const id = str(e.toolCallId) ?? ""
      const res = obj(e.result) ?? {}
      const sc = obj(res.structuredContent) ?? {}
      const exit = num(sc.exit_code)
      const text = contentText(res.content)
      const err = e.isError === true || exit !== null && exit !== 0
      const exitDetail = exit !== null && exit !== 0 ? `exit ${exit}` : null
      const detail = err ? firstLine(text) || exitDetail || "failed" : exitDetail
      let it = s.toolAt.get(id)
      if (!it || !s.items.includes(it)) {
        it = { kind: "tool", id, name: str(e.toolName) ?? "?", summary: "", state: "pending", detail: null, ms: null }
        s.toolAt.set(id, it)
        push(it)
      }
      it.state = err ? "error" : "ok"
      it.detail = detail
      it.ms = num(e.durationMs)
      break
    }
    case "message_end": {
      const m = obj(e.message)
      if (!m || m.role !== "assistant") break
      for (const it of s.items) {
        if ((it.kind === "text" || it.kind === "thinking") && !it.done) it.done = true
      }
      const u = obj(m.usage) ?? obj(e.usage)
      const turn = lastTurn(s)
      if (u && turn) {
        const cost = obj(u.cost)
        const inn = (num(u.input) ?? 0) + (num(u.cacheRead) ?? 0) + (num(u.cacheWrite) ?? 0)
        turn.inTokens = inn
        turn.outTokens = num(u.output)
        turn.costUsd = num(cost?.total)
      }
      break
    }
    case "auto_retry_start":
      push({ kind: "notice", text: "retrying after error", tone: "live" })
      break
    case "agent_settled":
      push({ kind: "notice", text: e.aborted === true ? "aborted" : "settled", tone: e.aborted === true ? "bad" : "dim" })
      break
  }
}

function cut(segs: Seg[], width: number): Seg[] {
  let used = 0
  const out: Seg[] = []
  for (const seg of segs) {
    if (used >= width) break
    const room = width - used
    if (seg.text.length <= room) {
      out.push(seg)
      used += seg.text.length
    } else {
      out.push({ text: seg.text.slice(0, Math.max(0, room - 1)) + "…", tone: seg.tone })
      used = width
    }
  }
  return out
}

/**
 * Render the timeline as theme-independent segments. `live` only changes
 * presentation: streaming text and composing rows appear, and a tool
 * without a result reads as still running rather than abandoned.
 */
export function streamLines(items: StreamItem[], live: boolean, width: number): Seg[][] {
  const lines: Seg[][] = []
  for (const it of items) {
    if (it.kind === "turn") {
      const usage = [
        it.inTokens !== null ? `${fmtTokens(it.inTokens)} in` : undefined,
        it.outTokens !== null ? `${fmtTokens(it.outTokens)} out` : undefined,
        it.costUsd !== null ? fmtCost(it.costUsd) : undefined,
      ]
        .filter(Boolean)
        .join("  ")
      lines.push(cut(
        [
          { text: `── turn ${it.index}`, tone: "border" },
          ...(usage ? [{ text: `  ${usage}`, tone: "muted" } as Seg] : []),
        ],
        width,
      ))
    } else if (it.kind === "thinking") {
      lines.push(cut([{ text: `  thinking · ${fmtTokens(it.chars)} chars`, tone: "dim" }], width))
    } else if (it.kind === "text") {
      const head = it.head.replace(/\s+/g, " ").trim()
      const tail = it.chars > head.length ? ` (+${fmtTokens(it.chars - head.length)} chars)` : ""
      lines.push(cut(
        [{ text: `  "${head}${head && !it.done ? "…" : ""}"${tail}`, tone: it.done || !live ? "muted" : "live" }],
        width,
      ))
    } else if (it.kind === "composing") {
      if (live) {
        lines.push(cut(
          [{ text: `  ◌ ${it.name} composing · ${fmtTokens(it.chars)} chars`, tone: "live" }],
          width,
        ))
      }
    } else if (it.kind === "tool") {
      const mark = it.state === "error" ? "✗" : it.state === "pending" ? "◌" : "●"
      const tone: SegTone = it.state === "error" ? "bad" : it.state === "pending" ? (live ? "live" : "bad") : "ok"
      const pending = it.state === "pending"
      const detail = pending && !live ? "no result (harness exited)" : it.detail
      lines.push(cut(
        [
          { text: `  ${mark} `, tone },
          { text: it.name, tone: "accent" },
          ...(it.summary ? [{ text: `  ${it.summary}`, tone: "muted" } as Seg] : []),
          ...(detail ? [{ text: `  ${detail}`, tone: "dim" } as Seg] : []),
          ...(it.ms !== null && !pending ? [{ text: `  ${fmtDuration(msToSecs(it.ms))}`, tone: "dim" } as Seg] : []),
        ],
        width,
      ))
    } else {
      lines.push(cut([{ text: `  ! ${it.text}`, tone: it.tone }], width))
    }
  }
  return lines
}

function msToSecs(ms: number): number {
  return Math.round(ms / 100) / 10
}

function fmtDuration(secs: number): string {
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m${String(Math.round(secs % 60)).padStart(2, "0")}`
}
