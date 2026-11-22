import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { NatsConnection, Subscription } from "@nats-io/transport-node"
import { currentContext } from "../pi/lib/current-context"
import { createNatsClient, type NatsClient, type NatsClientOptions } from "./client"
import { isContextAddress, operatorSubject, parseOperatorEvent, PendingOperatorChanges } from "./operator-events"
import { parseStoreEvent, storeEventLine, storeSubject } from "./store-events"

export function registerOperatorEvents(
  pi: ExtensionAPI,
  factory: (options: NatsClientOptions) => NatsClient = createNatsClient,
): void {
  let active = false
  let context: string | undefined
  let connection: NatsConnection | undefined
  let subscription: Subscription | undefined
  let storeSubscription: Subscription | undefined
  let sessionId: string | undefined
  let client: NatsClient | undefined
  let ui: ExtensionContext["ui"] | undefined
  let statusTimer: ReturnType<typeof setInterval> | undefined
  const pending = new PendingOperatorChanges()

  function status(): void {
    ui?.setStatus("operator-events", context ? `operator: ${client?.isConnected() ? "connected" : "disconnected"}` : undefined)
  }

  function subscribe(): void {
    subscription?.unsubscribe()
    subscription = undefined
    storeSubscription?.unsubscribe()
    storeSubscription = undefined
    if (!context || !connection || connection.isClosed()) return
    const linked = context
    const store = connection.subscribe(storeSubject(linked), {
      callback: (error, message) => {
        if (error || storeSubscription !== store || context !== linked) return
        try {
          const event = parseStoreEvent(message.json(), linked)
          if (!event || message.subject !== storeSubject(linked, event.event)) return
          if (sessionId && event.origin_session === sessionId) return
          pending.addStoreEvent(event.event_id, storeEventLine(event, linked))
        } catch {}
      },
    })
    storeSubscription = store
    const sub = connection.subscribe(operatorSubject(linked, ">"), {
      callback: (error, message) => {
        if (error || subscription !== sub || context !== linked || message.subject !== operatorSubject(linked)) return
        try {
          const event = parseOperatorEvent(message.json(), linked)
          if (event) pending.add(event)
        } catch {}
      },
    })
    subscription = sub
  }

  function link(address: unknown): void {
    context = isContextAddress(address) ? address : undefined
    pending.clear()
    subscribe()
    status()
  }

  const off = pi.events.on("cue:context-linked", (data: unknown) => {
    link((data as { address?: unknown } | undefined)?.address)
  })

  pi.on("session_start", (_event, ctx) => {
    active = true
    ui = ctx.hasUI ? ctx.ui : undefined
    sessionId = ctx.sessionManager.getSessionId()
    context = undefined
    pending.clear()
    client = factory({
      name: "pi operator events",
      onConnect: nc => {
        if (!active) return
        connection = nc
        subscribe()
        status()
      },
    })
    link(currentContext(ctx.sessionManager.getBranch()))
    client.start()
    status()
    statusTimer = setInterval(status, 2000)
    statusTimer.unref?.()
  })
  pi.on("session_tree", (_event, ctx) => {
    link(currentContext(ctx.sessionManager.getBranch()))
  })
  pi.on("before_agent_start", (event, ctx) => {
    const address = currentContext(ctx.sessionManager.getBranch())
    if (address !== context) link(address)
    if (event.messageType !== "user" || !context) return
    const summary = pending.take(context)
    if (summary) return { message: { customType: "operator-events", content: summary, display: true } }
  })
  pi.on("session_shutdown", async () => {
    active = false
    off()
    if (statusTimer) clearInterval(statusTimer)
    subscription?.unsubscribe()
    subscription = undefined
    storeSubscription?.unsubscribe()
    storeSubscription = undefined
    connection = undefined
    context = undefined
    pending.clear()
    ui?.setStatus("operator-events", undefined)
    await client?.close()
  })
}
