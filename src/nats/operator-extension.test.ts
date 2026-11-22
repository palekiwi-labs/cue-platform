import { expect, test } from "bun:test"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { connect } from "@nats-io/transport-node"
import { createNatsClient } from "./client"
import { registerOperatorEvents } from "./operator-extension"
import { operatorSubject } from "./operator-events"
import { storeSubject } from "./store-events"
import { natsServerBin, startJetStreamServer, waitFor } from "./test-server"

function harness(url: string, initial: string, sessionId: string = crypto.randomUUID()) {
  const handlers = new Map<string, Function>()
  let listener: ((data: unknown) => void) | undefined
  let address = initial
  const statuses: string[] = []
  const pi = {
    on: (name: string, fn: Function) => handlers.set(name, fn),
    events: {
      on: (_name: string, fn: (data: unknown) => void) => { listener = fn; return () => { listener = undefined } },
    },
  } as unknown as ExtensionAPI
  const ctx = {
    hasUI: true,
    ui: { setStatus: (_key: string, text?: string) => { if (text) statuses.push(text) } },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [{ type: "custom", customType: "cue-context", data: { address } }],
    },
  } as unknown as ExtensionContext
  registerOperatorEvents(pi, options => createNatsClient({ ...options, url }))
  return {
    statuses,
    emit: (name: string, event = {}) => handlers.get(name)!(event, ctx),
    link(next: string) { address = next; listener?.({ address }) },
    tree(next: string) { address = next; handlers.get("session_tree")!({}, ctx) },
  }
}

test.skipIf(!natsServerBin)("core NATS routes to both linked sessions, clears on relink and delivers only on user runs", async () => {
  const server = await startJetStreamServer()
  const a = "org/repo/review-pr-1"
  const b = "org/repo/review-pr-2"
  const first = harness(server.url, a)
  const second = harness(server.url, b)
  const third = harness(server.url, a)
  const pub = await connect({ servers: server.url })
  const event = (context: string, old_status = "open", new_status = "dismissed") => ({
    v: 1, ts: new Date().toISOString(), context, artifact_address: `${context}/review/runs/run/verifiers-a.json`,
    finding_id: "F3", old_status, new_status, actor: "operator",
  })
  const send = async (context: string, data = event(context)) => {
    pub.publish(operatorSubject(context), JSON.stringify(data))
    await pub.flush()
    await Bun.sleep(50)
  }
  try {
    for (const h of [first, second, third]) h.emit("session_start")
    await waitFor(() => [first, second, third].every(h => h.statuses.includes("operator: connected")))
    await send(a)
    expect(first.emit("before_agent_start", { messageType: "custom" })).toBeUndefined()
    expect(second.emit("before_agent_start", { messageType: "user" })).toBeUndefined()
    for (const h of [first, third]) {
      const result = h.emit("before_agent_start", { messageType: "user" })
      expect(result.message).toMatchObject({ customType: "operator-events", display: true })
      expect(result.message.content).toContain("open -> dismissed")
      expect(h.emit("before_agent_start", { messageType: "user" })).toBeUndefined()
    }
    await send(a)
    await send(a, event(a, "dismissed", "open"))
    expect(first.emit("before_agent_start", { messageType: "user" })).toBeUndefined()
    await send(a)
    first.link(b)
    expect(first.emit("before_agent_start", { messageType: "user" })).toBeUndefined()
    await send(a)
    expect(first.emit("before_agent_start", { messageType: "user" })).toBeUndefined()
    await send(b, event(a))
    expect(first.emit("before_agent_start", { messageType: "user" })).toBeUndefined()
    await send(b)
    expect(first.emit("before_agent_start", { messageType: "user" }).message.content).toContain("[operator] F3 open -> dismissed")
    await send(b)
    first.tree(a)
    expect(first.emit("before_agent_start", { messageType: "user" })).toBeUndefined()
  } finally {
    for (const h of [first, second, third]) await h.emit("session_shutdown")
    await pub.close()
    await server.stop()
  }
})

test.skipIf(!natsServerBin)("store events reach the linked session once, without echoes or a turn", async () => {
  const server = await startJetStreamServer()
  const a = "org/repo/hooks"
  const b = "org/repo/other"
  const self = harness(server.url, a, "self-session")
  const peer = harness(server.url, b, "peer-session")
  const pub = await connect({ servers: server.url })
  let n = 0
  const event = (context: string, patch: Record<string, unknown> = {}) => {
    const id = `evt-${++n}`
    return {
      v: 1, event: "artifact_create", event_id: id, address: `${context}/note/idea.md`,
      occurred_at: new Date().toISOString(), context, type: "note", title: "An idea",
      origin_session: "writer", parent_event_id: null, root_event_id: id, depth: 1, ...patch,
    }
  }
  const send = async (data: Record<string, unknown>, subject = storeSubject(data.context as string, data.event as string)) => {
    pub.publish(subject, JSON.stringify(data))
    await pub.flush()
    await Bun.sleep(50)
  }
  try {
    for (const h of [self, peer]) h.emit("session_start")
    await waitFor(() => [self, peer].every(h => h.statuses.includes("operator: connected")))
    const first = event(a)
    await send(first)
    await send(first)
    await send(event(a, { origin_session: "self-session", title: "Echo" }))
    await send(event(a, { event: "log_entry_add", type: "log", address: `${a}/log/1.json`, title: "Shipped" }))
    await send(event(a, { event: "context_create", type: "context", address: a, title: "Hooks" }))
    await send(event(a), storeSubject(a, "log_entry_add"))
    await send(event(b, { context: a }), storeSubject(b, "artifact_create"))
    expect(self.emit("before_agent_start", { messageType: "custom" })).toBeUndefined()
    expect(peer.emit("before_agent_start", { messageType: "user" })).toBeUndefined()
    const result = self.emit("before_agent_start", { messageType: "user" })
    expect(result.message.content).toBe([
      "<operator-events>",
      "[cue] note/idea.md created: An idea",
      "[cue] log: Shipped",
      "[cue] context hooks created: Hooks",
      "</operator-events>",
    ].join("\n"))
    await send(first)
    expect(self.emit("before_agent_start", { messageType: "user" })).toBeUndefined()
  } finally {
    for (const h of [self, peer]) await h.emit("session_shutdown")
    await pub.close()
    await server.stop()
  }
})
