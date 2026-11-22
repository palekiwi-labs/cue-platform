export const STORE_EVENTS = ["artifact_create", "artifact_update", "context_create", "log_entry_add"] as const
export type StoreEventName = typeof STORE_EVENTS[number]

export interface StoreEvent {
  v: 1
  event: StoreEventName
  event_id: string
  address: string
  occurred_at: string
  context: string
  type: string
  title: string | null
  origin_session: string | null
  parent_event_id: string | null
  root_event_id: string
  depth: number
  actor?: string
  summary?: string
}

const ID = /^[\w.:-]{1,128}$/
const ACTOR = /^[a-z][a-z0-9-]{0,31}$/
const TITLE_MAX = 1024
const TITLE_SHOWN = 160

export function storeSubject(context: string, event = ">"): string {
  return `cue.evt.v1.${Buffer.from(context, "utf8").toString("base64url")}.${event}`
}

export function isContextAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= 512
    && /^[\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+$/u.test(value)
    && value.split("/").every(p => p !== "." && p !== "..")
}

function isStoreEvent(value: unknown): value is StoreEventName {
  return STORE_EVENTS.includes(value as StoreEventName)
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= 1024 && /^[\p{L}\p{N}_./-]+$/u.test(value)
    && value.split("/").every(p => p && p !== "." && p !== "..")
}

function typeFor(event: StoreEventName, segments: string[]): string | undefined {
  if (event === "context_create") return segments.length === 3 ? "context" : undefined
  if (event === "log_entry_add") return segments.length === 5 && segments[3] === "log" && segments[4]!.endsWith(".json") ? "log" : undefined
  return segments.length >= 5 && /^[a-z]{1,16}$/.test(segments[3]!) && segments[3] !== "log" ? segments[3] : undefined
}

export function parseStoreEvent(value: unknown, context: string): StoreEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const e = value as Record<string, unknown>
  if (e.v !== 1 || !isStoreEvent(e.event) || e.context !== context || !isContextAddress(e.context)) return
  if (typeof e.event_id !== "string" || !ID.test(e.event_id)) return
  if (typeof e.occurred_at !== "string" || !/^\d{4}-\d\d-\d\dT/.test(e.occurred_at) || !Number.isFinite(Date.parse(e.occurred_at))) return
  if (!isAddress(e.address) || (e.address !== context && !e.address.startsWith(`${context}/`))) return
  if (typeof e.type !== "string" || e.type !== typeFor(e.event, e.address.split("/"))) return
  if (e.title !== null && (typeof e.title !== "string" || e.title.length > TITLE_MAX)) return
  if (e.origin_session !== null && (typeof e.origin_session !== "string" || !ID.test(e.origin_session))) return
  if (e.parent_event_id !== null && (typeof e.parent_event_id !== "string" || !ID.test(e.parent_event_id))) return
  if (typeof e.root_event_id !== "string" || !ID.test(e.root_event_id)) return
  if (typeof e.depth !== "number" || !Number.isInteger(e.depth) || e.depth < 0 || e.depth > 64) return
  if (e.actor !== undefined && (typeof e.actor !== "string" || !ACTOR.test(e.actor))) return
  if (e.summary !== undefined && (typeof e.summary !== "string" || e.summary.length > TITLE_MAX)) return
  return e as unknown as StoreEvent
}

function clean(text: string | null | undefined): string | undefined {
  if (text == null) return
  const flat = text.replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, " ").replace(/<\/?session-events/gi, "session-events").trim()
  if (!flat) return
  return flat.length > TITLE_SHOWN ? `${flat.slice(0, TITLE_SHOWN - 3)}...` : flat
}

export function storeEventLine(event: StoreEvent, context: string): string {
  const tag = `[${event.actor ?? "cue"}]`
  const title = clean(event.title)
  const relative = event.address.slice(context.length + 1)
  if (event.event === "context_create") {
    const slug = event.address.slice(event.address.lastIndexOf("/") + 1)
    return `${tag} context ${slug} created${title ? `: ${title}` : ""}`
  }
  if (event.event === "log_entry_add") return `${tag} log: ${title ?? relative}`
  if (event.event === "artifact_update") {
    const summary = clean(event.summary)
    return `${tag} ${relative} updated${summary ? `: ${summary}` : title ? `: ${title}` : ""}`
  }
  return `${tag} ${relative} created${title ? `: ${title}` : ""}`
}

export class PendingEvents {
  private readonly lines = new Map<string, string>()
  private overflow = 0
  private readonly seen = new Set<string>()

  constructor(private readonly limit = 100, private readonly seenLimit = 1000) {}

  clear(): void {
    this.lines.clear()
    this.overflow = 0
  }

  add(eventId: string, line: string): boolean {
    if (this.seen.has(eventId)) return false
    this.seen.add(eventId)
    if (this.seen.size > this.seenLimit) this.seen.delete(this.seen.values().next().value!)
    if (this.lines.size < this.limit) this.lines.set(eventId, line)
    else this.overflow = Math.min(Number.MAX_SAFE_INTEGER, this.overflow + 1)
    return true
  }

  take(): string | undefined {
    if (!this.lines.size && !this.overflow) return
    const lines = [...this.lines.values()]
    if (this.overflow) lines.push(`[cue] ${this.overflow} more events`)
    this.clear()
    return ["<session-events>", ...lines, "</session-events>"].join("\n")
  }
}
