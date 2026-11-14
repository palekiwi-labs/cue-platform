import { afterEach, describe, expect, test } from "bun:test"
import { connect, type NatsConnection } from "@nats-io/transport-node"
import { jetstream } from "@nats-io/jetstream"
import { eventSubject, subjectToken, type AgentEvent, type RegistryRow } from "./events"
import { ensureInfra, openRegistry } from "./jetstream"
import { formatActivity } from "./monitor-model"
import { openMonitorSource, type MonitorSource } from "./monitor-source"
import { natsServerBin, startJetStreamServer, waitFor, type TestServer } from "./test-server"

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function setup(): Promise<{ server: TestServer; nc: NatsConnection }> {
  const server = await startJetStreamServer()
  cleanups.push(() => server.stop())
  const nc = await connect({ servers: server.url })
  cleanups.push(() => nc.close())
  await ensureInfra(nc, undefined)
  return { server, nc }
}

function row(sid: string, over: Partial<RegistryRow> = {}): RegistryRow {
  const now = Date.now()
  return { v: 1, sid, host: "h", state: "busy", turns: 1, tokens: 0, cost: 0, started_at: now, updated_at: now, ...over }
}

let seq = 0
function event(sid: string, kind: AgentEvent["kind"], fields: Record<string, unknown> = {}): AgentEvent {
  return { v: 1, ts: Date.now(), sid, host: "h", kind, seq: ++seq, ...fields }
}

describe("openMonitorSource", () => {
  test("rejects with a clear message when NATS is unreachable", async () => {
    const promise = openMonitorSource({ url: "nats://127.0.0.1:1", domain: null, connectTimeoutMs: 1000 })
    await expect(promise).rejects.toThrow("cannot connect to NATS at nats://127.0.0.1:1")
  })
})

describe.skipIf(!natsServerBin)("openMonitorSource with a server", () => {
  test("delivers rows, the selected session's events, and removes deleted rows", async () => {
    const { server, nc } = await setup()
    const kv = await openRegistry(nc, undefined)
    const js = jetstream(nc)
    const sid = "20261114-134753-ae2a53-builder-1"
    const other = "other-session"
    await kv.put(subjectToken(sid), JSON.stringify(row(sid, { run_id: sid })))
    await js.publish(eventSubject(sid, "input"), JSON.stringify(event(sid, "input", { source: "user", preview: "go" })))
    await js.publish(eventSubject(other, "input"), JSON.stringify(event(other, "input", { source: "user", preview: "nope" })))
    await js.publish(
      eventSubject(sid, "tool_start"),
      JSON.stringify(event(sid, "tool_start", { call_id: "c1", tool: "bash", args: "ls" })),
    )

    const source: MonitorSource = await openMonitorSource({ url: server.url, domain: null })
    cleanups.push(() => source.close())

    await waitFor(() => source.rows().some((r) => r.sid === sid))
    source.select(sid)
    await waitFor(() => source.activity().items.length >= 2)

    await js.publish(
      eventSubject(sid, "tool_end"),
      JSON.stringify(event(sid, "tool_end", { call_id: "c1", tool: "bash", ok: true, duration_ms: 5 })),
    )
    await waitFor(() => source.activity().items.some((i) => i.kind === "tool" && i.status === "ok"))
    expect(source.activity().items.map(formatActivity)).toEqual(["> [user] go", "ok  bash ls (5ms)"])

    await kv.delete(subjectToken(sid))
    await waitFor(() => source.rows().length === 0)
  })

  test("rebuilds run history from the stream and keeps it live; registry becomes ready", async () => {
    const { server, nc } = await setup()
    const js = jetstream(nc)
    const done = "20261114-134753-ae2a53-builder-0"
    const live = "20261114-134753-ae2a53-builder-1"
    await js.publish(eventSubject(done, "start"), JSON.stringify(event(done, "start", { reason: "startup", cwd: "/w" })))
    await js.publish(eventSubject(done, "tool_start"), JSON.stringify(event(done, "tool_start", { call_id: "c" })))
    await js.publish(eventSubject(done, "end"), JSON.stringify(event(done, "end", { reason: "quit", turns: 1, cost: 0.2 })))

    const source = await openMonitorSource({ url: server.url, domain: null })
    cleanups.push(() => source.close())
    expect(source.registryReady()).toBe(true)
    await waitFor(() => source.history().runs.get(done)?.ended === true)
    expect(source.history().runs.get(done)?.cwd).toBe("/w")

    await js.publish(eventSubject(live, "start"), JSON.stringify(event(live, "start", { reason: "startup" })))
    await waitFor(() => source.history().runs.has(live))
  })

  test("switching selection replaces the activity", async () => {
    const { server, nc } = await setup()
    const js = jetstream(nc)
    await js.publish(eventSubject("a", "input"), JSON.stringify(event("a", "input", { source: "user", preview: "from a" })))
    await js.publish(eventSubject("b", "input"), JSON.stringify(event("b", "input", { source: "user", preview: "from b" })))

    const source = await openMonitorSource({ url: server.url, domain: null })
    cleanups.push(() => source.close())
    source.select("a")
    await waitFor(() => source.activity().items.length === 1)
    source.select("b")
    await waitFor(() => source.activity().items.length === 1 && source.selected() === "b")
    await Bun.sleep(100)
    expect(source.activity().items.map(formatActivity)).toEqual(["> [user] from b"])
  })
})
