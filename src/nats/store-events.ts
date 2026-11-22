import { isContextAddress } from "./operator-events"

export const STORE_EVENTS = ["artifact_create", "context_create", "log_entry_add"] as const
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
}

const ID = /^[\w.:-]{1,128}$/
const TITLE_MAX = 1024
const TITLE_SHOWN = 160

export function storeSubject(context: string, event = ">"): string {
  return `cue.evt.v1.${Buffer.from(context, "utf8").toString("base64url")}.${event}`
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
  return e as unknown as StoreEvent
}

function cleanTitle(title: string | null): string | undefined {
  if (title === null) return
  const flat = title.replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, " ").replace(/<\/?operator-events/gi, "operator-events").trim()
  if (!flat) return
  return flat.length > TITLE_SHOWN ? `${flat.slice(0, TITLE_SHOWN - 3)}...` : flat
}

export function storeEventLine(event: StoreEvent, context: string): string {
  const title = cleanTitle(event.title)
  const relative = event.address.slice(context.length + 1)
  if (event.event === "context_create") {
    const slug = event.address.slice(event.address.lastIndexOf("/") + 1)
    return `[cue] context ${slug} created${title ? `: ${title}` : ""}`
  }
  if (event.event === "log_entry_add") return `[cue] log: ${title ?? relative}`
  return `[cue] ${relative} created${title ? `: ${title}` : ""}`
}
