import { describe, expect, test } from "bun:test"
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent"
import { CastMcpClient, McpClientError, type McpTool } from "./client"
import { McpToolSet } from "./register"
import { makeFakePi } from "./testing"

type CallFn = (
  cwd: string,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>

function fakeClient(call: CallFn): CastMcpClient {
  return { call } as unknown as CastMcpClient
}

const ctx = { cwd: "/work" } as unknown as ExtensionToolContext

const tool = (name: string, description = `does ${name}`): McpTool => ({
  name,
  description,
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
})

const textResult = (text: string) => ({ content: [{ type: "text", text }] })

function setup(options: { excluded?: string[]; call?: CallFn; onCallFailure?: (e: Error) => void } = {}) {
  const fake = makeFakePi(options.excluded)
  const calls: { cwd: string; tool: string; args: Record<string, unknown> }[] = []
  const call: CallFn =
    options.call ??
    (async (cwd, tool, args) => {
      calls.push({ cwd, tool, args })
      return textResult(`ran ${tool}`)
    })
  const set = new McpToolSet(fake.pi, fakeClient(call), {
    onCallFailure: options.onCallFailure ?? (() => {}),
  })
  return { ...fake, set, calls }
}

describe("McpToolSet first discovery", () => {
  test("registers one pi tool per MCP tool with opencode names", () => {
    const { set, registry, active } = setup()
    set.apply([tool("db_inspect_table"), tool("spabreaks:_run_rspec")])
    expect([...registry.keys()].sort()).toEqual([
      "mcp-cast_db_inspect_table",
      "mcp-cast_spabreaks__run_rspec",
    ])
    expect(active().sort()).toEqual([...registry.keys()].sort())
    expect(set.names().sort()).toEqual([...registry.keys()].sort())
  })

  test("passes description and input schema through unchanged", () => {
    const { set, registry } = setup()
    const t = tool("x", "Inspect a table.")
    set.apply([t])
    const def = registry.get("mcp-cast_x")!
    expect(def.description).toBe("Inspect a table.")
    expect(def.parameters as unknown).toEqual(t.inputSchema)
    expect(def.label).toContain("x")
  })

  test("a tool without a description gets a generic one", () => {
    const { set, registry } = setup()
    set.apply([{ name: "bare", inputSchema: { type: "object" } }])
    expect(registry.get("mcp-cast_bare")!.description).toContain("bare")
  })

  test("does not call setActiveTools when nothing needs deactivating", () => {
    const { set, setActiveCalls } = setup()
    set.apply([tool("a")])
    expect(setActiveCalls).toEqual([])
  })
})

describe("McpToolSet execute", () => {
  test("calls the original MCP tool name with the params and ctx cwd", async () => {
    const { set, registry, calls } = setup()
    set.apply([tool("spabreaks:_run_rspec")])
    const result = await registry
      .get("mcp-cast_spabreaks__run_rspec")!
      .execute("id", { q: "1" }, undefined, undefined, ctx)
    expect(calls).toEqual([{ cwd: "/work", tool: "spabreaks:_run_rspec", args: { q: "1" } }])
    expect(result.content).toEqual([{ type: "text", text: "ran spabreaks:_run_rspec" }])
    expect((result.details as any).tool).toBe("spabreaks:_run_rspec")
  })

  test("forwards the abort signal to the client", async () => {
    let seen: AbortSignal | undefined
    const { set, registry } = setup({
      call: async (_c, _t, _a, signal) => {
        seen = signal
        return textResult("ok")
      },
    })
    set.apply([tool("a")])
    const controller = new AbortController()
    await registry.get("mcp-cast_a")!.execute("id", {}, controller.signal, undefined, ctx)
    expect(seen).toBe(controller.signal)
  })

  test("an MCP error result is thrown without reporting a call failure", async () => {
    const failures: Error[] = []
    const { set, registry } = setup({
      call: async () => ({ isError: true, content: [{ type: "text", text: "bad table" }] }),
      onCallFailure: (e) => failures.push(e),
    })
    set.apply([tool("a")])
    await expect(
      registry.get("mcp-cast_a")!.execute("id", {}, undefined, undefined, ctx),
    ).rejects.toThrow("bad table")
    expect(failures).toEqual([])
  })

  test("a client failure is reported, then rethrown", async () => {
    const failures: Error[] = []
    const error = new McpClientError("cast-mcp-client call cast a failed: refused")
    const { set, registry } = setup({
      call: async () => {
        throw error
      },
      onCallFailure: (e) => failures.push(e),
    })
    set.apply([tool("a")])
    await expect(
      registry.get("mcp-cast_a")!.execute("id", {}, undefined, undefined, ctx),
    ).rejects.toThrow("refused")
    expect(failures).toEqual([error])
  })

  test("a failing failure hook does not mask the call error", async () => {
    const { set, registry } = setup({
      call: async () => {
        throw new McpClientError("refused")
      },
      onCallFailure: () => {
        throw new Error("probe broke")
      },
    })
    set.apply([tool("a")])
    await expect(
      registry.get("mcp-cast_a")!.execute("id", {}, undefined, undefined, ctx),
    ).rejects.toThrow("refused")
  })
})

describe("McpToolSet rediscovery", () => {
  test("overwrites definitions of tools still provided", () => {
    const { set, registry } = setup()
    set.apply([tool("a", "old")])
    set.apply([tool("a", "new")])
    expect(registry.get("mcp-cast_a")!.description).toBe("new")
  })

  test("deactivates vanished tools and keeps unrelated active tools", () => {
    const { set, active, setActive } = setup()
    set.apply([tool("a"), tool("b")])
    setActive(["read", ...active()])
    set.apply([tool("a")])
    expect(active()).toEqual(["read", "mcp-cast_a"])
    expect(set.names()).toEqual(["mcp-cast_a"])
  })

  test("a vanished tool that is still called fails with a clear message", async () => {
    const { set, registry, calls } = setup()
    set.apply([tool("a"), tool("b")])
    set.apply([tool("a")])
    await expect(
      registry.get("mcp-cast_b")!.execute("id", {}, undefined, undefined, ctx),
    ).rejects.toThrow("no longer provided by the cast MCP server")
    expect(calls).toEqual([])
  })

  test("re-activates a returning tool the adapter deactivated", () => {
    const { set, active } = setup()
    set.apply([tool("a"), tool("b")])
    set.apply([tool("a")])
    set.apply([tool("a"), tool("b")])
    expect(active().sort()).toEqual(["mcp-cast_a", "mcp-cast_b"])
  })

  test("does not re-activate a returning tool the user had deactivated", () => {
    const { set, active, setActive } = setup()
    set.apply([tool("a"), tool("b")])
    setActive(["mcp-cast_a"])
    set.apply([tool("a")])
    set.apply([tool("a"), tool("b")])
    expect(active()).toEqual(["mcp-cast_a"])
  })

  test("never forces an excluded tool into the active set", () => {
    const { set, active, setActiveCalls } = setup({ excluded: ["mcp-cast_b"] })
    set.apply([tool("a"), tool("b")])
    expect(active()).toEqual(["mcp-cast_a"])
    set.apply([tool("a")])
    set.apply([tool("a"), tool("b")])
    expect(active()).toEqual(["mcp-cast_a"])
    expect(setActiveCalls.flat()).not.toContain("mcp-cast_b")
  })

  test("an empty discovery deactivates every generated tool", () => {
    const { set, active, setActive } = setup()
    set.apply([tool("a")])
    setActive(["read", "mcp-cast_a"])
    set.apply([])
    expect(active()).toEqual(["read"])
    expect(set.names()).toEqual([])
  })
})
