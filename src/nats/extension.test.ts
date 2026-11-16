import { afterEach, describe, expect, test } from "bun:test"
import { connect, type NatsConnection } from "@nats-io/transport-node"
import { jetstreamManager } from "@nats-io/jetstream"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readContextTitle, readTmuxNames, registerNatsTelemetry } from "./extension"
import { EVENT_STREAM, type AgentEvent, type RegistryRow } from "./events"
import { openRegistry } from "./jetstream"
import { natsServerBin, startJetStreamServer, waitFor, type TestServer } from "./test-server"

type Handler = (event: unknown, ctx: unknown) => unknown

function fakePi() {
  const handlers = new Map<string, Handler[]>()
  const pi = {
    on(name: string, h: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), h])
    },
  } as unknown as ExtensionAPI
  async function fire(name: string, event: Record<string, unknown>, ctx: unknown) {
    for (const h of handlers.get(name) ?? []) await h({ type: name, ...event }, ctx)
  }
  return { pi, fire }
}

function fakeCtx(sid: string, branch: unknown[] = []) {
  return {
    mode: "json",
    cwd: "/work",
    model: { provider: "anthropic", id: "opus" },
    sessionManager: {
      getSessionId: () => sid,
      getSessionFile: () => undefined,
      getSessionName: () => "named",
      getBranch: () => branch,
    },
  }
}

function tempStore(contexts: Record<string, string>): string {
  const store = mkdtempSync(join(tmpdir(), "nats-store-"))
  for (const [address, md] of Object.entries(contexts)) {
    mkdirSync(join(store, address), { recursive: true })
    writeFileSync(join(store, address, "context.md"), md)
  }
  return store
}

describe("readTmuxNames", () => {
  function execPi(results: Record<string, { code: number; stdout: string } | Error>) {
    const calls: string[][] = []
    const pi = {
      async exec(command: string, args: string[]) {
        calls.push([command, ...args])
        const r = results[args[args.length - 1] as string]
        if (r instanceof Error) throw r
        return { stdout: r?.stdout ?? "", stderr: "", code: r?.code ?? 1, killed: false }
      },
    } as unknown as ExtensionAPI
    return { pi, calls }
  }
  const env = { TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%3" }

  test("reads the window and session names of the pane", async () => {
    const { pi, calls } = execPi({
      "#{window_name}": { code: 0, stdout: "notifications\n" },
      "#{session_name}": { code: 0, stdout: "palekiwi\n" },
    })
    expect(await readTmuxNames(pi, env, true)).toEqual({ window: "notifications", session: "palekiwi" })
    expect(calls).toContainEqual(["tmux", "display-message", "-p", "-t", "%3", "#{window_name}"])
  })

  test("reports nothing outside tmux, without a tty, or when tmux fails", async () => {
    const { pi, calls } = execPi({ "#{window_name}": new Error("gone"), "#{session_name}": { code: 1, stdout: "x" } })
    expect(await readTmuxNames(pi, {}, true)).toEqual({})
    expect(await readTmuxNames(pi, env, false)).toEqual({})
    expect(calls).toEqual([])
    expect(await readTmuxNames(pi, env, true)).toEqual({ window: undefined, session: undefined })
  })
})

describe("readContextTitle", () => {
  test("reads the title from the store and never throws", () => {
    const store = tempStore({ "o/r/ctx": "---\ntitle: The title\n---\n", "o/r/desc": "---\ndescription: Desc\n---\n" })
    try {
      expect(readContextTitle("o/r/ctx", { CUE_STORE: store })).toBe("The title")
      expect(readContextTitle("o/r/desc", { CUE_STORE: store })).toBe("Desc")
      expect(readContextTitle("o/r/missing", { CUE_STORE: store })).toBeUndefined()
      expect(readContextTitle("o/../ctx", { CUE_STORE: store })).toBeUndefined()
      expect(readContextTitle(undefined, { CUE_STORE: store })).toBeUndefined()
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })
})

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function setup(): Promise<{ server: TestServer; nc: NatsConnection }> {
  const server = await startJetStreamServer()
  cleanups.push(() => server.stop())
  const nc = await connect({ servers: server.url })
  cleanups.push(() => nc.close())
  return { server, nc }
}

describe.skipIf(!natsServerBin)("registerNatsTelemetry", () => {
  test("creates stream and bucket, publishes events and maintains the registry row", async () => {
    const { server, nc } = await setup()
    const { pi, fire } = fakePi()
    const sid = "20261114-134753-ae2a53-builder-1"
    const store = tempStore({ "o/r/first": "---\ntitle: First\n---\n", "o/r/second": "---\ntitle: Second\n---\n" })
    cleanups.push(async () => rmSync(store, { recursive: true, force: true }))
    const branch: unknown[] = [
      { type: "custom", customType: "session-description", data: { text: "Initial description" } },
    ]
    const ctx = fakeCtx(sid, branch)
    let t = 1000
    registerNatsTelemetry(pi, {
      url: server.url,
      env: { CUE_NATS_JS_DOMAIN: "", CUE_STORE: store, CUE_CONTEXT: "o/r/first", CUE_AGENT_NAME: "builder" },
      host: "casm",
      now: () => t,
      tmuxNames: async () => ({ window: "second", session: "palekiwi" }),
    })
    cleanups.push(() => fire("session_shutdown", { reason: "quit" }, ctx))

    await fire("session_start", { reason: "startup" }, ctx)
    branch.push({ type: "custom", customType: "cue-context", data: { address: "o/r/second" } })
    await fire("before_agent_start", { messageType: "user", prompt: "hello there" }, ctx)
    t += 3000
    await fire("turn_start", { turnIndex: 0 }, ctx)
    await fire("message_update", { assistantMessageEvent: { type: "thinking_start" } }, ctx)
    await fire("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { command: "ls" } }, ctx)
    await fire("tool_execution_end", { toolCallId: "c1", toolName: "bash", isError: false, durationMs: 7 }, ctx)
    await fire(
      "turn_end",
      { turnIndex: 0, message: { role: "assistant", usage: { totalTokens: 12, cost: { total: 0.5 } } } },
      ctx,
    )
    branch.push({ type: "custom", customType: "session-description", data: { text: " Updated description " } })
    await fire("agent_settled", { aborted: false }, ctx)

    const jsm = await jetstreamManager(nc)
    await waitFor(async () => {
      try {
        return (await jsm.streams.info(EVENT_STREAM)).state.messages >= 8
      } catch {
        return false
      }
    })
    const kv = await openRegistry(nc, undefined)
    let row: RegistryRow | undefined
    await waitFor(async () => {
      const e = await kv.get(sid)
      row = e && e.operation === "PUT" ? (e.json() as RegistryRow) : undefined
      return row?.state === "idle" && row.turns === 1
    })
    expect(row).toMatchObject({
      run_id: sid,
      host: "casm",
      mode: "json",
      model: "anthropic/opus",
      tokens: 12,
      agent: "builder",
      context: "o/r/second",
      context_title: "Second",
    })
    expect(row!.cost).toBeCloseTo(0.5)
    expect(row!.last_tool).toBe("bash ls")

    const js = (await import("@nats-io/jetstream")).jetstream(nc)
    const consumer = await js.consumers.get(EVENT_STREAM, { filter_subjects: [`agent.evt.${sid}.>`] })
    const events: AgentEvent[] = []
    const msgs = await consumer.fetch({ max_messages: 8, expires: 2000 })
    for await (const m of msgs) {
      events.push(m.json() as AgentEvent)
      if (events.length === 8) break
    }
    expect(events.map((e) => e.kind)).toEqual([
      "start",
      "input",
      "turn_start",
      "thinking",
      "tool_start",
      "tool_end",
      "turn_end",
      "settled",
    ])
    expect(events[0]).toMatchObject({
      agent: "builder", context: "o/r/first", context_title: "First", session_description: "Initial description",
    })
    expect(events[7]).toMatchObject({
      aborted: false,
      errored: false,
      context: "o/r/second",
      context_title: "Second",
      session_name: "named",
      session_description: "Updated description",
      tmux_window: "second",
      tmux_session: "palekiwi",
      cwd: "/work",
      run_id: sid,
      agent: "builder",
      turn_ms: 3000,
      tools: 1,
    })

    await fire("session_shutdown", { reason: "quit" }, ctx)
    await waitFor(async () => {
      const e = await kv.get(sid)
      return !e || e.operation !== "PUT"
    })
  })

  test("keeps running without a server and never throws", async () => {
    const { pi, fire } = fakePi()
    const ctx = fakeCtx("offline")
    registerNatsTelemetry(pi, { url: "nats://127.0.0.1:1", env: { CUE_NATS_JS_DOMAIN: "" } })
    await fire("session_start", { reason: "startup" }, ctx)
    await fire("before_agent_start", { messageType: "user", prompt: "x" }, ctx)
    await fire("agent_settled", { aborted: false }, ctx)
    await fire("session_shutdown", { reason: "quit" }, ctx)
  })

  test("is inert when disabled", async () => {
    const { pi, fire } = fakePi()
    registerNatsTelemetry(pi, { env: { CUE_NATS_DISABLE: "1" } })
    await fire("session_start", { reason: "startup" }, fakeCtx("x"))
  })
})
