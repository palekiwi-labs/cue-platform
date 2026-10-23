import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CastMcpClient,
  ClientNotFoundError,
  McpClientError,
  nodeSpawner,
  parseList,
  parseStatus,
  type SpawnOptions,
  type SpawnResult,
} from "./client"

describe("parseStatus", () => {
  test("no cast entry means not configured", () => {
    expect(parseStatus("[]")).toEqual({ kind: "not-configured" })
    expect(parseStatus('[{"name":"other","status":"ok"}]')).toEqual({ kind: "not-configured" })
  })

  test("ok entry is reachable with its url", () => {
    const out = '[{"name":"cast","url":"http://h:1/mcp","status":"ok"}]'
    expect(parseStatus(out)).toEqual({ kind: "reachable", url: "http://h:1/mcp" })
  })

  test("error entry is unreachable with the error text", () => {
    const out = '[{"name":"cast","url":"http://h:1/mcp","status":"error","error":"refused"}]'
    expect(parseStatus(out)).toEqual({
      kind: "unreachable",
      url: "http://h:1/mcp",
      error: "refused",
    })
  })

  test("garbage raises a client error", () => {
    expect(() => parseStatus("nope")).toThrow(McpClientError)
    expect(() => parseStatus("{}")).toThrow(McpClientError)
  })
})

describe("parseList", () => {
  test("returns the cast tools with name, description and schema", () => {
    const schema = { type: "object", properties: { id: { type: "string" } } }
    const out = JSON.stringify({
      cast: [{ name: "fetch_doc", description: "Fetch", inputSchema: schema, annotations: {} }],
    })
    expect(parseList(out)).toEqual([
      { name: "fetch_doc", description: "Fetch", inputSchema: schema },
    ])
  })

  test("missing cast key means unreachable", () => {
    expect(parseList("{}")).toBeNull()
  })

  test("a tool without a schema gets an empty object schema", () => {
    expect(parseList('{"cast":[{"name":"x"}]}')).toEqual([
      { name: "x", description: undefined, inputSchema: { type: "object", properties: {} } },
    ])
  })
})

function fakeSpawner(result: Partial<SpawnResult>) {
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = []
  const spawner = async (command: string, args: string[], options: SpawnOptions) => {
    calls.push({ command, args, options })
    return { code: 0, stdout: "", stderr: "", killed: false, ...result }
  }
  return { spawner, calls }
}

describe("CastMcpClient", () => {
  test("call sends arguments as JSON on stdin and parses the result", async () => {
    const { spawner, calls } = fakeSpawner({
      stdout: '{"content":[{"type":"text","text":"hi"}]}',
    })
    const client = new CastMcpClient(spawner)
    const result = await client.call("/w", "echo", { a: 1 })
    expect(result).toEqual({ content: [{ type: "text", text: "hi" }] })
    expect(calls[0].command).toBe("cast-mcp-client")
    expect(calls[0].args).toEqual(["call", "cast", "echo", "-"])
    expect(calls[0].options.stdin).toBe('{"a":1}')
    expect(calls[0].options.cwd).toBe("/w")
  })

  test("non-zero exit raises a client error carrying stderr", async () => {
    const { spawner } = fakeSpawner({ code: 1, stderr: "Error: connection refused" })
    const client = new CastMcpClient(spawner)
    await expect(client.call("/w", "echo", {})).rejects.toThrow(/connection refused/)
    await expect(client.call("/w", "echo", {})).rejects.toBeInstanceOf(McpClientError)
  })

  test("a missing binary raises a client error", async () => {
    const client = new CastMcpClient(async () => {
      throw new Error("spawn ENOENT")
    })
    await expect(client.status("/w")).rejects.toThrow(/could not be run: spawn ENOENT/)
  })

  test("a binary absent from PATH raises ClientNotFoundError", async () => {
    const client = new CastMcpClient(nodeSpawner, "cast-mcp-client-does-not-exist")
    const error = await client.status(tmpdir()).catch((e) => e)
    expect(error).toBeInstanceOf(ClientNotFoundError)
    expect(error).toBeInstanceOf(McpClientError)
  })

  test("list queries only the cast server", async () => {
    const { spawner, calls } = fakeSpawner({ stdout: '{"cast":[]}' })
    await new CastMcpClient(spawner).list("/w", 500)
    expect(calls[0].args).toEqual(["list", "cast"])
    expect(calls[0].options.timeoutMs).toBe(500)
  })
})

async function fakeBinary(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-client-test-"))
  const path = join(dir, "fake-client")
  await writeFile(path, `#!/usr/bin/env bash\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

describe("nodeSpawner", () => {
  test("pipes stdin and captures stdout, stderr and exit code", async () => {
    const bin = await fakeBinary('cat; echo "$1" >&2; exit 3')
    const result = await nodeSpawner(bin, ["arg"], { cwd: tmpdir(), stdin: '{"x":1}' })
    expect(result).toEqual({ code: 3, stdout: '{"x":1}', stderr: "arg\n", killed: false })
  })

  test("abort kills the child", async () => {
    const bin = await fakeBinary("sleep 30")
    const controller = new AbortController()
    const started = Date.now()
    const pending = nodeSpawner(bin, [], { cwd: tmpdir(), signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    const result = await pending
    expect(result.killed).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  test("timeout kills the child", async () => {
    const bin = await fakeBinary("sleep 30")
    const result = await nodeSpawner(bin, [], { cwd: tmpdir(), timeoutMs: 50 })
    expect(result.killed).toBe(true)
  })

  test("an already aborted signal never spawns", async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await nodeSpawner("/nonexistent", [], {
      cwd: tmpdir(),
      signal: controller.signal,
    })
    expect(result.killed).toBe(true)
  })
})
