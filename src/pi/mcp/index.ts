import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { CastMcpClient, ClientNotFoundError, type McpClientError } from "./client"
import { McpToolSet } from "./register"
import { Backoff, type ConnectionState } from "./state"
import { registerMcpCastCommand, STATUS_KEY, statusText, unreachableWarning } from "./ui"

export interface AdapterOptions {
  client?: CastMcpClient
  backoff?: Backoff
  /** Longest a prompt waits for a pending discovery. */
  promptTimeoutMs?: number
  statusTimeoutMs?: number
  listTimeoutMs?: number
  /** Timeout of the health probe run after a failed call. */
  probeTimeoutMs?: number
}

const DEFAULTS = {
  promptTimeoutMs: 3_000,
  statusTimeoutMs: 5_000,
  listTimeoutMs: 10_000,
  probeTimeoutMs: 3_000,
}

function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    promise.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      () => {
        clearTimeout(timer)
        resolve()
      },
    )
  })
}

/**
 * Exposes the built-in cast MCP server's tools as pi tools.
 *
 * Discovery runs without blocking session startup, and is retried before
 * prompts while the server is unreachable. A prompt waits briefly for a
 * pending discovery, because tools registered before the first model call
 * of a turn are already visible to it.
 */
export class McpCastAdapter {
  state: ConnectionState = { kind: "inactive" }
  readonly tools: McpToolSet
  private readonly client: CastMcpClient
  private readonly backoff: Backoff
  private readonly options: typeof DEFAULTS
  private ctx?: ExtensionContext
  private inflight?: Promise<void>
  private warned = false

  constructor(pi: ExtensionAPI, options: AdapterOptions = {}) {
    this.client = options.client ?? new CastMcpClient()
    this.backoff = options.backoff ?? new Backoff()
    this.options = {
      promptTimeoutMs: options.promptTimeoutMs ?? DEFAULTS.promptTimeoutMs,
      statusTimeoutMs: options.statusTimeoutMs ?? DEFAULTS.statusTimeoutMs,
      listTimeoutMs: options.listTimeoutMs ?? DEFAULTS.listTimeoutMs,
      probeTimeoutMs: options.probeTimeoutMs ?? DEFAULTS.probeTimeoutMs,
    }
    this.tools = new McpToolSet(pi, this.client, {
      onCallFailure: (error) => this.onCallFailure(error),
    })
  }

  /** Remember the latest context; earlier ones go stale on session replacement. */
  attach(ctx: ExtensionContext): void {
    this.ctx = ctx
  }

  sessionStarted(ctx: ExtensionContext): void {
    this.attach(ctx)
    this.warned = false
    void this.discover()
  }

  async beforePrompt(ctx: ExtensionContext): Promise<void> {
    this.attach(ctx)
    if (!this.inflight) {
      if (this.state.kind !== "unreachable" || !this.backoff.ready()) return
      void this.discover()
    }
    if (this.inflight) await waitAtMost(this.inflight, this.options.promptTimeoutMs)
  }

  async reconnect(): Promise<void> {
    if (this.inflight) await this.inflight
    this.setState({ kind: "connecting" })
    await this.discover()
  }

  /** Resolves when no discovery is pending. */
  async idle(): Promise<void> {
    while (this.inflight) await this.inflight
  }

  private discover(): Promise<void> {
    if (this.inflight) return this.inflight
    const run = this.runDiscovery()
      .catch(() => {})
      .finally(() => {
        if (this.inflight === run) this.inflight = undefined
      })
    this.inflight = run
    return run
  }

  private async runDiscovery(): Promise<void> {
    const cwd = this.cwd()
    let status
    try {
      status = await this.client.status(cwd, this.options.statusTimeoutMs)
    } catch (error) {
      if (error instanceof ClientNotFoundError) return this.becomeInactive()
      return this.becomeUnreachable(undefined, (error as Error).message)
    }
    if (status.kind === "not-configured") return this.becomeInactive()
    if (status.kind === "unreachable") return this.becomeUnreachable(status.url, status.error)

    if (this.state.kind !== "connected") this.setState({ kind: "connecting" })
    let tools
    try {
      tools = await this.client.list(cwd, this.options.listTimeoutMs)
    } catch (error) {
      return this.becomeUnreachable(status.url, (error as Error).message)
    }
    if (tools === null) {
      return this.becomeUnreachable(status.url, "the server did not answer the tool listing")
    }
    this.tools.apply(tools)
    this.backoff.reset()
    this.setState({ kind: "connected", url: status.url, toolCount: this.tools.names().length })
  }

  private async onCallFailure(_error: McpClientError): Promise<void> {
    let status
    try {
      status = await this.client.status(this.cwd(), this.options.probeTimeoutMs)
    } catch (error) {
      if (error instanceof ClientNotFoundError) return
      return this.becomeUnreachable(undefined, (error as Error).message)
    }
    if (status.kind === "unreachable") this.becomeUnreachable(status.url, status.error)
  }

  private becomeInactive(): void {
    if (this.tools.names().length > 0) this.tools.apply([])
    this.setState({ kind: "inactive" })
  }

  private becomeUnreachable(url: string | undefined, error: string): void {
    const state = { kind: "unreachable" as const, url, error }
    this.backoff.failure()
    this.setState(state)
    if (!this.warned) {
      this.warned = true
      this.withUi((ui) => ui.notify(unreachableWarning(state), "warning"))
    }
  }

  private setState(state: ConnectionState): void {
    this.state = state
    this.withUi((ui) => ui.setStatus(STATUS_KEY, statusText(state)))
  }

  private cwd(): string {
    return this.ctx?.cwd ?? process.cwd()
  }

  /** Runs against the latest context's UI; pi throws once a context is stale. */
  private withUi(fn: (ui: ExtensionContext["ui"]) => void): void {
    try {
      if (this.ctx) fn(this.ctx.ui)
    } catch {
      // A stale context belongs to a replaced session; its UI is gone.
    }
  }
}

export function registerMcpCastAdapter(
  pi: ExtensionAPI,
  options: AdapterOptions = {},
): McpCastAdapter {
  const adapter = new McpCastAdapter(pi, options)
  pi.on("session_start", (_event, ctx) => adapter.sessionStarted(ctx))
  pi.on("before_agent_start", async (_event, ctx) => {
    await adapter.beforePrompt(ctx)
  })
  registerMcpCastCommand(pi, adapter)
  return adapter
}
