import { expect, test } from "bun:test"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { connect } from "@nats-io/transport-node"
import { createNatsClient } from "./client"
import { storeSubject } from "./store-events"
import { formatSubscriptions, registerSessionSubscriptions, subscriptionsStatus } from "./subscriptions"
import { natsServerBin, startJetStreamServer, waitFor } from "./test-server"

function harness(url: string, initial: string | undefined, sessionId: string = crypto.randomUUID()) {
  const handlers = new Map<string, Function>()
  const commands = new Map<string, { handler: Function }>()
  const eventHandlers = new Map<string, (data: unknown) => void>()
  let address = initial
  const statuses: (string | undefined)[] = []
  const notes: string[] = []
  const pi = {
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerCommand: (name: string, options: { handler: Function }) => commands.set(name, options),
    events: {
      on: (name: string, fn: (data: unknown) => void) => {
        eventHandlers.set(name, fn)
        return () => { eventHandlers.delete(name) }
      },
      emit: (name: string, data: unknown) => { eventHandlers.get(name)?.(data) },
    },
  } as unknown as ExtensionAPI
  const ctx = {
    hasUI: true,
    ui: {
      setStatus: (_key: string, text?: string) => { statuses.push(text) },
      notify: (text: string) => { notes.push(text) },
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => address ? [{ type: "custom", customType: "cue-context", data: { address } }] : [],
    },
  } as unknown as ExtensionContext
  registerSessionSubscriptions(pi, options => createNatsClient({ ...options, url }))
  return {
    statuses,
    notes,
    emit: (name: string, event = {}) => handlers.get(name)!(event, ctx),
    link(next: string) { address = next; eventHandlers.get("cue:context-linked")?.({ address: next }) },
    fire(name: string, data: unknown) { eventHandlers.get(name)?.(data) },
    tree(next: string) { address = next; handlers.get("session_tree")!({}, ctx) },
    async list() { await commands.get("subscriptions")!.handler("", ctx); return notes.at(-1)! },
  }
}

test("status and listing formats", () => {
  expect(subscriptionsStatus(0)).toBeUndefined()
  expect(subscriptionsStatus(1)).toBe("1 sub")
  expect(subscriptionsStatus(3)).toBe("3 subs")
  expect(formatSubscriptions([])).toContain("No subscriptions")
  const now = new Date("2026-11-23T10:00:00Z")
  expect(formatSubscriptions([{
    name: "context", address: "org/repo/ctx", subject: "cue.evt.v1.x.>", events: 2,
    lastEventAt: new Date("2026-11-23T09:58:30Z"),
  }], now)).toBe([
    "context  org/repo/ctx",
    "  subject  cue.evt.v1.x.>",
    "  events   2, last 1m ago",
  ].join("\n"))
})

test.skipIf(!natsServerBin)("store events reach the linked session once, including the session's own writes, and are counted", async () => {
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
    expect(self.statuses.at(-1)).toBe("1 sub")
    await Bun.sleep(200)
    const first = event(a)
    await send(first)
    await send(first)
    await send(event(a, { origin_session: "self-session", address: `${a}/note/own.md`, title: "Own" }))
    await send(event(a, { event: "log_entry_add", type: "log", address: `${a}/log/1.json`, title: "Shipped" }))
    await send(event(a, {
      event: "artifact_update", type: "review", address: `${a}/review/runs/r/v.json`, title: null,
      actor: "operator", summary: "F3 open -> dismissed",
    }))
    await send(event(a), storeSubject(a, "log_entry_add"))
    await send(event(b, { context: a }), storeSubject(b, "artifact_create"))
    await waitFor(async () => (await self.list()).includes("events   4"))
    expect(self.emit("before_agent_start", { messageType: "custom" })).toBeUndefined()
    expect(peer.emit("before_agent_start", { messageType: "user" })).toBeUndefined()
    const result = self.emit("before_agent_start", { messageType: "user" })
    expect(result.message).toMatchObject({ customType: "session-events", display: true })
    expect(result.message.content).toBe([
      "<session-events>",
      `[cue] created: ${a}/note/idea.md`,
      `[cue] created: ${a}/note/own.md`,
      `[cue] logged: ${a}/log/1.json`,
      `[operator] updated: ${a}/review/runs/r/v.json (F3 open -> dismissed)`,
      "</session-events>",
    ].join("\n"))
    await send(first)
    expect(self.emit("before_agent_start", { messageType: "user" })).toBeUndefined()

    self.link(b)
    expect(await self.list()).toContain(`context  ${b}`)
    expect(await self.list()).toContain("events   0")
    await Bun.sleep(100)
    await send(event(a))
    expect(self.emit("before_agent_start", { messageType: "user" })).toBeUndefined()
    await send(event(b))
    expect(self.emit("before_agent_start", { messageType: "user" }).message.content).toContain(`[cue] created: ${b}/note/idea.md`)
    await send(event(b))
    self.tree(a)
    expect(self.emit("before_agent_start", { messageType: "user" })).toBeUndefined()
  } finally {
    for (const h of [self, peer]) await h.emit("session_shutdown")
    await pub.close()
    await server.stop()
  }
})

test("no linked context means no subscriptions and no footer", async () => {
  const h = harness("nats://127.0.0.1:1", undefined)
  h.emit("session_start")
  expect(h.statuses.filter(Boolean)).toEqual([])
  expect(await h.list()).toContain("No subscriptions")
  await h.emit("session_shutdown")
})

test.skipIf(!natsServerBin)("a queued task_set reaches the setting session once and names it for peers", async () => {
  const server = await startJetStreamServer()
  const a = "org/repo/hooks"
  const self = harness(server.url, a, "self-session")
  const peer = harness(server.url, a, "peer-session")
  const pub = await connect({ servers: server.url })
  const event = {
    v: 1, event: "task_set", event_id: "task-evt-1", address: `${a}/task/t.md`,
    occurred_at: new Date().toISOString(), context: a, type: "task", title: null,
    origin_session: "self-session", parent_event_id: null, root_event_id: "task-evt-1", depth: 0,
    scope: "session", session_id: "self-session", reason: "selection",
  }
  try {
    for (const h of [self, peer]) h.emit("session_start")
    await Bun.sleep(200)
    self.fire("cue:task-set-queued", event)
    pub.publish(storeSubject(a, "task_set"), JSON.stringify(event))
    await pub.flush()
    await Bun.sleep(50)
    const own = self.emit("before_agent_start", { messageType: "user" })!.message.content
    expect(own).toContain(`<session-events>\n[cue] set active task: ${a}/task/t.md\n</session-events>`)
    expect(own.match(/set active task/g)).toHaveLength(1)
    const seen = peer.emit("before_agent_start", { messageType: "user" })!.message.content
    expect(seen).toContain(`[cue] set active task: ${a}/task/t.md (self-session)`)
  } finally {
    for (const h of [self, peer]) await h.emit("session_shutdown")
    await pub.close()
    await server.stop()
  }
})

test("a queued task_set outside the linked context is not injected", () => {
  const h = harness("nats://127.0.0.1:1", "org/repo/hooks")
  h.emit("session_start")
  h.fire("cue:task-set-queued", {
    v: 1, event: "task_set", event_id: "x", address: "org/repo/other/task/t.md",
    occurred_at: new Date().toISOString(), context: "org/repo/other", type: "task", title: null,
    origin_session: null, parent_event_id: null, root_event_id: "x", depth: 0,
    scope: "session", session_id: "s", reason: "selection",
  })
  expect(h.emit("before_agent_start", { messageType: "user" })).toBeUndefined()
})
