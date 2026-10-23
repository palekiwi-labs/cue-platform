import { describe, expect, test } from "bun:test"
import {
  CastMcpClient,
  ClientNotFoundError,
  McpClientError,
  type McpTool,
  type ServerStatus,
} from "./client"
import { registerMcpCastAdapter } from "./index"
import { Backoff } from "./state"
import { makeFakePi } from "./testing"

const URL = "http://host:30301/mcp"

const tool = (name: string): McpTool => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: "object", properties: {} },
})

/** Fake client whose answers can be changed between steps. */
function fakeClient() {
  const state = {
    status: { kind: "reachable", url: URL } as ServerStatus | Error,
    list: [tool("a"), tool("b")] as McpTool[] | null,
    call: { content: [{ type: "text", text: "ok" }] } as Record<string, unknown> | Error,
    statusCalls: 0,
    listCalls: 0,
    gate: undefined as Promise<void> | undefined,
  }
  const client = {
    status: async () => {
      state.statusCalls++
      if (state.gate) await state.gate
      if (state.status instanceof Error) throw state.status
      return state.status
    },
    list: async () => {
      state.listCalls++
      return state.list
    },
    call: async () => {
      if (state.call instanceof Error) throw state.call
      return state.call
    },
  } as unknown as CastMcpClient
  return { client, state }
}

function fakeCtx() {
  const statuses: (string | undefined)[] = []
  const notes: { message: string; type?: string }[] = []
  const ctx = {
    cwd: "/work",
    hasUI: true,
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        expect(key).toBe("mcp-cast")
        statuses.push(text)
      },
      notify: (message: string, type?: string) => notes.push({ message, type }),
    },
  } as any
  return {
    ctx,
    statuses,
    notes,
    lastStatus: () => statuses[statuses.length - 1],
    warnings: () => notes.filter((n) => n.type === "warning"),
  }
}

function clock() {
  let t = 0
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

function setup(options: { excluded?: string[] } = {}) {
  const fake = makeFakePi(options.excluded)
  const { client, state } = fakeClient()
  const c = clock()
  const ui = fakeCtx()
  const adapter = registerMcpCastAdapter(fake.pi, {
    client,
    backoff: new Backoff(5000, 60000, c.now),
    promptTimeoutMs: 50,
  })
  return { ...fake, adapter, state, clock: c, ...ui }
}

const sessionStart = (s: ReturnType<typeof setup>) =>
  s.fire("session_start", { type: "session_start", reason: "startup" }, s.ctx)
const beforeAgentStart = (s: ReturnType<typeof setup>) =>
  s.fire("before_agent_start", { type: "before_agent_start", prompt: "hi" }, s.ctx)

describe("session_start", () => {
  test("does not await discovery", async () => {
    const s = setup()
    let release!: () => void
    s.state.gate = new Promise((r) => (release = r))
    await sessionStart(s)
    expect(s.registry.size).toBe(0)
    release()
    await s.adapter.idle()
    expect([...s.registry.keys()].sort()).toEqual(["mcp-cast_a", "mcp-cast_b"])
  })

  test("connected shows the tool count", async () => {
    const s = setup()
    await sessionStart(s)
    await s.adapter.idle()
    expect(s.adapter.state).toEqual({ kind: "connected", url: URL, toolCount: 2 })
    expect(s.lastStatus()).toContain("2 tools")
    expect(s.notes).toEqual([])
  })

  test("not configured shows no status and no notification", async () => {
    const s = setup()
    s.state.status = { kind: "not-configured" }
    await sessionStart(s)
    await s.adapter.idle()
    expect(s.adapter.state).toEqual({ kind: "inactive" })
    expect(s.statuses.filter((x) => x !== undefined)).toEqual([])
    expect(s.notes).toEqual([])
    expect(s.state.listCalls).toBe(0)
  })

  test("a missing client binary counts as not configured", async () => {
    const s = setup()
    s.state.status = new ClientNotFoundError("cast-mcp-client could not be run: ENOENT")
    await sessionStart(s)
    await s.adapter.idle()
    expect(s.adapter.state).toEqual({ kind: "inactive" })
    expect(s.statuses.filter((x) => x !== undefined)).toEqual([])
    expect(s.notes).toEqual([])
  })

  test("unreachable shows a reconnect hint and warns once", async () => {
    const s = setup()
    s.state.status = { kind: "unreachable", url: URL, error: "refused" }
    await sessionStart(s)
    await s.adapter.idle()
    expect(s.adapter.state).toEqual({ kind: "unreachable", url: URL, error: "refused" })
    expect(s.lastStatus()).toContain("/mcp-cast reconnect")
    expect(s.warnings()).toHaveLength(1)
    expect(s.warnings()[0].message).toContain("unreachable")

    s.clock.advance(5000)
    await beforeAgentStart(s)
    expect(s.state.statusCalls).toBe(2)
    expect(s.warnings()).toHaveLength(1)
  })

  test("list failing after a good status is unreachable", async () => {
    const s = setup()
    s.state.list = null
    await sessionStart(s)
    await s.adapter.idle()
    expect(s.adapter.state.kind).toBe("unreachable")
  })

  test("a new session warns again", async () => {
    const s = setup()
    s.state.status = { kind: "unreachable", url: URL, error: "refused" }
    await sessionStart(s)
    await s.adapter.idle()
    await s.fire("session_start", { type: "session_start", reason: "new" }, s.ctx)
    await s.adapter.idle()
    expect(s.warnings()).toHaveLength(2)
  })
})

describe("before_agent_start", () => {
  test("does nothing while connected", async () => {
    const s = setup()
    await sessionStart(s)
    await s.adapter.idle()
    await beforeAgentStart(s)
    expect(s.state.statusCalls).toBe(1)
  })

  test("does nothing when not configured", async () => {
    const s = setup()
    s.state.status = { kind: "not-configured" }
    await sessionStart(s)
    await s.adapter.idle()
    s.clock.advance(60000)
    await beforeAgentStart(s)
    expect(s.state.statusCalls).toBe(1)
  })

  test("retries while unreachable, honouring the backoff", async () => {
    const s = setup()
    s.state.status = { kind: "unreachable", url: URL, error: "refused" }
    await sessionStart(s)
    await s.adapter.idle()

    await beforeAgentStart(s)
    expect(s.state.statusCalls).toBe(1)

    s.clock.advance(5000)
    await beforeAgentStart(s)
    expect(s.state.statusCalls).toBe(2)

    s.clock.advance(5000)
    await beforeAgentStart(s)
    expect(s.state.statusCalls).toBe(2)
  })

  test("a server started mid-session is registered before the prompt runs", async () => {
    const s = setup()
    s.state.status = { kind: "unreachable", url: URL, error: "refused" }
    await sessionStart(s)
    await s.adapter.idle()
    s.state.status = { kind: "reachable", url: URL }
    s.clock.advance(5000)
    await beforeAgentStart(s)
    expect([...s.registry.keys()].sort()).toEqual(["mcp-cast_a", "mcp-cast_b"])
    expect(s.adapter.state.kind).toBe("connected")
  })

  test("waits for startup discovery still in flight", async () => {
    const s = setup()
    let release!: () => void
    s.state.gate = new Promise((r) => (release = r))
    await sessionStart(s)
    setTimeout(release, 10)
    await beforeAgentStart(s)
    expect(s.registry.size).toBe(2)
  })

  test("waits at most the prompt timeout", async () => {
    const s = setup()
    s.state.gate = new Promise(() => {})
    await sessionStart(s)
    const started = Date.now()
    await beforeAgentStart(s)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(s.registry.size).toBe(0)
  })
})

describe("call failures", () => {
  test("a client failure with an unreachable probe flips the state", async () => {
    const s = setup()
    await sessionStart(s)
    await s.adapter.idle()
    s.state.call = new McpClientError("refused")
    s.state.status = { kind: "unreachable", url: URL, error: "refused" }
    await expect(
      s.registry.get("mcp-cast_a")!.execute("id", {}, undefined, undefined, s.ctx),
    ).rejects.toThrow("refused")
    expect(s.adapter.state.kind).toBe("unreachable")
    expect(s.lastStatus()).toContain("/mcp-cast reconnect")
  })

  test("a client failure with a healthy probe keeps the state", async () => {
    const s = setup()
    await sessionStart(s)
    await s.adapter.idle()
    s.state.call = new McpClientError("invalid params")
    await expect(
      s.registry.get("mcp-cast_a")!.execute("id", {}, undefined, undefined, s.ctx),
    ).rejects.toThrow("invalid params")
    expect(s.adapter.state.kind).toBe("connected")
  })
})

describe("/mcp-cast command", () => {
  const run = (s: ReturnType<typeof setup>, args: string) =>
    s.commands.get("mcp-cast").handler(args, s.ctx)

  test("is registered with a description", () => {
    const s = setup()
    expect(s.commands.get("mcp-cast").description).toBeTruthy()
  })

  test("completion offers both subcommands, filtered by prefix", async () => {
    const s = setup()
    const complete = s.commands.get("mcp-cast").getArgumentCompletions
    const values = async (p: string) => ((await complete(p)) ?? []).map((i: any) => i.value)
    expect(await values("")).toEqual(["status", "reconnect"])
    expect(await values("re")).toEqual(["reconnect"])
    expect(await values("x")).toEqual([])
  })

  test("status reports state, url and registered tools", async () => {
    const s = setup()
    await sessionStart(s)
    await s.adapter.idle()
    await run(s, "status")
    const report = s.notes[s.notes.length - 1].message
    expect(report).toContain("connected")
    expect(report).toContain(URL)
    expect(report).toContain("mcp-cast_a")
    expect(report).toContain("mcp-cast_b")
  })

  test("no argument means status", async () => {
    const s = setup()
    s.state.status = { kind: "not-configured" }
    await sessionStart(s)
    await s.adapter.idle()
    await run(s, "")
    expect(s.notes[s.notes.length - 1].message).toContain("not configured")
  })

  test("reconnect forces rediscovery, ignoring the backoff", async () => {
    const s = setup()
    s.state.status = { kind: "unreachable", url: URL, error: "refused" }
    await sessionStart(s)
    await s.adapter.idle()
    s.state.status = { kind: "reachable", url: URL }
    s.state.list = [tool("a"), tool("c")]
    await run(s, "reconnect")
    expect(s.adapter.state).toEqual({ kind: "connected", url: URL, toolCount: 2 })
    expect(s.active()).toContain("mcp-cast_c")
    expect(s.notes[s.notes.length - 1].message).toContain("2 tools")
  })

  test("reconnect deactivates tools the restarted server dropped", async () => {
    const s = setup()
    await sessionStart(s)
    await s.adapter.idle()
    s.state.list = [tool("a")]
    await run(s, "reconnect")
    expect(s.active()).toEqual(["mcp-cast_a"])
  })

  test("an unknown subcommand reports usage", async () => {
    const s = setup()
    await run(s, "bogus")
    const last = s.notes[s.notes.length - 1]
    expect(last.type).toBe("error")
    expect(last.message).toContain("status")
    expect(last.message).toContain("reconnect")
  })
})
