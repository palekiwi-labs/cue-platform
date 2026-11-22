import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { NatsConnection, Subscription } from "@nats-io/transport-node"
import { currentContext } from "../pi/lib/current-context"
import { createNatsClient, type NatsClient, type NatsClientOptions } from "./client"
import { isContextAddress, parseStoreEvent, PendingEvents, storeEventLine, storeSubject } from "./store-events"

export const SUBSCRIPTIONS_STATUS_KEY = "session-subscriptions"
export const SESSION_EVENTS_TYPE = "session-events"

export interface SessionSubscription {
  name: string
  address: string
  subject: string
  events: number
  lastEventAt?: Date
}

interface Active extends SessionSubscription {
  nats?: Subscription
}

export function subscriptionsStatus(count: number): string | undefined {
  if (!count) return
  return `${count} ${count === 1 ? "sub" : "subs"}`
}

export function formatSubscriptions(subs: SessionSubscription[], now = new Date()): string {
  if (!subs.length) return "No subscriptions: link a cue context to subscribe to its events."
  return subs.map(s => [
    `${s.name}  ${s.address}`,
    `  subject  ${s.subject}`,
    `  events   ${s.events}${s.lastEventAt ? `, last ${ago(s.lastEventAt, now)}` : ""}`,
  ].join("\n")).join("\n\n")
}

function ago(at: Date, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function registerSessionSubscriptions(
  pi: ExtensionAPI,
  factory: (options: NatsClientOptions) => NatsClient = createNatsClient,
): void {
  let active = false
  let context: string | undefined
  let connection: NatsConnection | undefined
  let sessionId: string | undefined
  let client: NatsClient | undefined
  let ui: ExtensionContext["ui"] | undefined
  let subs: Active[] = []
  const pending = new PendingEvents()

  function status(): void {
    ui?.setStatus(SUBSCRIPTIONS_STATUS_KEY, subscriptionsStatus(subs.length))
  }

  function unsubscribe(): void {
    for (const sub of subs) sub.nats?.unsubscribe()
    subs = []
  }

  function listen(): void {
    for (const sub of subs) {
      sub.nats?.unsubscribe()
      sub.nats = undefined
    }
    if (!context || !connection || connection.isClosed()) return
    const linked = context
    for (const sub of subs) {
      const nats = connection.subscribe(sub.subject, {
        callback: (error, message) => {
          if (error || sub.nats !== nats || context !== linked) return
          try {
            const event = parseStoreEvent(message.json(), linked)
            if (!event || message.subject !== storeSubject(linked, event.event)) return
            if (sessionId && event.origin_session === sessionId) return
            if (!pending.add(event.event_id, storeEventLine(event, linked))) return
            sub.events++
            sub.lastEventAt = new Date()
          } catch {}
        },
      })
      sub.nats = nats
    }
  }

  function link(address: unknown): void {
    const next = isContextAddress(address) ? address : undefined
    if (next === context && subs.length) return
    unsubscribe()
    context = next
    pending.clear()
    if (context) subs = [{ name: "context", address: context, subject: storeSubject(context), events: 0 }]
    listen()
    status()
  }

  const off = pi.events.on("cue:context-linked", (data: unknown) => {
    link((data as { address?: unknown } | undefined)?.address)
  })

  pi.registerCommand("subscriptions", {
    description: "List this session's event subscriptions",
    handler: async (_args, ctx) => {
      const text = formatSubscriptions(subs)
      if (ctx.hasUI) ctx.ui.notify(text, "info")
      else console.log(text)
    },
  })

  pi.on("session_start", (_event, ctx) => {
    active = true
    ui = ctx.hasUI ? ctx.ui : undefined
    sessionId = ctx.sessionManager.getSessionId()
    context = undefined
    unsubscribe()
    pending.clear()
    client = factory({
      name: "pi session subscriptions",
      onConnect: nc => {
        if (!active) return
        connection = nc
        listen()
      },
    })
    link(currentContext(ctx.sessionManager.getBranch()))
    client.start()
  })
  pi.on("session_tree", (_event, ctx) => {
    link(currentContext(ctx.sessionManager.getBranch()))
  })
  pi.on("before_agent_start", (event, ctx) => {
    const address = currentContext(ctx.sessionManager.getBranch())
    if (address !== context) link(address)
    if (event.messageType !== "user" || !context) return
    const summary = pending.take()
    if (summary) return { message: { customType: SESSION_EVENTS_TYPE, content: summary, display: true } }
  })
  pi.on("session_shutdown", async () => {
    active = false
    off()
    unsubscribe()
    connection = undefined
    context = undefined
    pending.clear()
    ui?.setStatus(SUBSCRIPTIONS_STATUS_KEY, undefined)
    await client?.close()
  })
}
