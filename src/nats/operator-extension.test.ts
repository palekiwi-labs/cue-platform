import { expect, test } from "bun:test"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { connect } from "@nats-io/transport-node"
import { createNatsClient } from "./client"
import { registerOperatorEvents } from "./operator-extension"
import { operatorSubject } from "./operator-events"
import { natsServerBin, startJetStreamServer, waitFor } from "./test-server"

function harness(url: string, initial: string) {
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
    sessionManager: { getBranch: () => [{ type: "custom", customType: "cue-context", data: { address } }] },
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
    expect(first.emit("before_agent_start", { messageType: "user" }).message.content).toContain(b)
    await send(b)
    first.tree(a)
    expect(first.emit("before_agent_start", { messageType: "user" })).toBeUndefined()
  } finally {
    for (const h of [first, second, third]) await h.emit("session_shutdown")
    await pub.close()
    await server.stop()
  }
})
