import { spawn } from "node:child_process"
import { CAST_SERVER } from "./naming"

/**
 * The only place that talks to the cast MCP server: every operation shells
 * out to `cast-mcp-client`, which owns URL and config resolution, transport
 * and protocol. Parsing is kept in pure functions so it can be tested
 * without the binary.
 */

export const CLIENT_BINARY = "cast-mcp-client"

export interface McpTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export type ServerStatus =
  | { kind: "not-configured" }
  | { kind: "unreachable"; url?: string; error: string }
  | { kind: "reachable"; url?: string }

export interface SpawnOptions {
  cwd: string
  stdin?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export interface SpawnResult {
  code: number
  stdout: string
  stderr: string
  /** True when the process was killed by the abort signal or the timeout. */
  killed: boolean
}

export type Spawner = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => Promise<SpawnResult>

/** Failure to reach the server or run the client, as opposed to a tool error. */
export class McpClientError extends Error {}

/** The client binary is not on PATH: not running inside a cast sandbox. */
export class ClientNotFoundError extends McpClientError {}

export function parseStatus(stdout: string): ServerStatus {
  let entries: unknown
  try {
    entries = JSON.parse(stdout)
  } catch {
    throw new McpClientError(`unparseable status output: ${stdout.trim()}`)
  }
  if (!Array.isArray(entries)) {
    throw new McpClientError("status output is not a JSON array")
  }
  const entry = entries.find(
    (e): e is { url?: string; status?: string; error?: string } =>
      typeof e === "object" && e !== null && (e as { name?: unknown }).name === CAST_SERVER,
  )
  if (!entry) return { kind: "not-configured" }
  if (entry.status === "ok") return { kind: "reachable", url: entry.url }
  return {
    kind: "unreachable",
    url: entry.url,
    error: entry.error ?? `status ${String(entry.status)}`,
  }
}

/**
 * Parse `cast-mcp-client list cast`. Returns null when the server is absent
 * from the output, which is how the client reports an unreachable server.
 */
export function parseList(stdout: string): McpTool[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new McpClientError(`unparseable list output: ${stdout.trim()}`)
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new McpClientError("list output is not a JSON object")
  }
  const tools = (parsed as Record<string, unknown>)[CAST_SERVER]
  if (tools === undefined) return null
  if (!Array.isArray(tools)) {
    throw new McpClientError("list output for cast is not an array")
  }
  return tools
    .filter((t) => typeof t?.name === "string")
    .map((t) => ({
      name: t.name,
      description: typeof t.description === "string" ? t.description : undefined,
      inputSchema:
        typeof t.inputSchema === "object" && t.inputSchema !== null
          ? t.inputSchema
          : { type: "object", properties: {} },
    }))
}

function failure(args: string[], result: SpawnResult): McpClientError {
  const what = `${CLIENT_BINARY} ${args.slice(0, 3).join(" ")}`
  if (result.killed) return new McpClientError(`${what} was cancelled or timed out`)
  const diagnostic = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`
  return new McpClientError(`${what} failed: ${diagnostic}`)
}

export class CastMcpClient {
  constructor(
    private readonly spawner: Spawner = nodeSpawner,
    private readonly binary: string = CLIENT_BINARY,
  ) {}

  private async run(args: string[], options: SpawnOptions): Promise<SpawnResult> {
    let result: SpawnResult
    try {
      result = await this.spawner(this.binary, args, options)
    } catch (error) {
      const message = `${this.binary} could not be run: ${(error as Error).message}`
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ClientNotFoundError(message)
      }
      throw new McpClientError(message)
    }
    if (result.code !== 0 || result.killed) throw failure(args, result)
    return result
  }

  async status(cwd: string, timeoutMs?: number): Promise<ServerStatus> {
    const result = await this.run(["status"], { cwd, timeoutMs })
    return parseStatus(result.stdout)
  }

  /** Lists the cast server's tools; null when the server is unreachable. */
  async list(cwd: string, timeoutMs?: number): Promise<McpTool[] | null> {
    const result = await this.run(["list", CAST_SERVER], { cwd, timeoutMs })
    return parseList(result.stdout)
  }

  /** Calls a tool, returning the raw MCP CallToolResult object. */
  async call(
    cwd: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const argv = ["call", CAST_SERVER, tool, "-"]
    const result = await this.run(argv, { cwd, signal, stdin: JSON.stringify(args) })
    try {
      return JSON.parse(result.stdout)
    } catch {
      throw new McpClientError(`unparseable call output: ${result.stdout.trim()}`)
    }
  }
}

/**
 * child_process spawner. pi.exec cannot be used for calls because it
 * spawns with stdin ignored, and arguments travel on stdin to avoid the
 * per-argument size limit of argv.
 */
export const nodeSpawner: Spawner = (command, args, options) =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({ code: 1, stdout: "", stderr: "", killed: true })
      return
    }
    // Own process group, so cancellation also reaches children of a wrapper
    // script, which would otherwise keep the pipes open after the kill.
    const proc = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let killed = false
    let timer: NodeJS.Timeout | undefined
    let forceKill: NodeJS.Timeout | undefined

    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        if (proc.pid) process.kill(-proc.pid, signal)
      } catch {
        proc.kill(signal)
      }
    }
    const kill = () => {
      if (killed) return
      killed = true
      signalGroup("SIGTERM")
      forceKill = setTimeout(() => signalGroup("SIGKILL"), 2000)
      forceKill.unref()
    }
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (forceKill) clearTimeout(forceKill)
      options.signal?.removeEventListener("abort", kill)
    }

    options.signal?.addEventListener("abort", kill, { once: true })
    if (options.timeoutMs) timer = setTimeout(kill, options.timeoutMs)

    proc.stdout.on("data", (d) => (stdout += d))
    proc.stderr.on("data", (d) => (stderr += d))
    proc.stdin.on("error", () => {})
    proc.stdin.end(options.stdin ?? "")
    proc.on("error", (error) => {
      cleanup()
      reject(error)
    })
    proc.on("close", (code) => {
      cleanup()
      resolve({ code: code ?? 1, stdout, stderr, killed })
    })
  })
