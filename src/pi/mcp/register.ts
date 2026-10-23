import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { TSchema } from "typebox"
import { McpClientError, type CastMcpClient, type McpTool } from "./client"
import { piToolName } from "./naming"
import { mapCallResult, type MapOptions, type McpResultDetails } from "./result"

export interface McpToolSetHooks {
  /** Called when the client fails to run or reach the server during a call. */
  onCallFailure: (error: McpClientError) => unknown
  mapOptions?: MapOptions
}

/**
 * The pi tools generated from the cast MCP server's tool list.
 *
 * pi has no unregister, so a tool that disappears from the server stays
 * registered: it is deactivated and its execute refuses to run. Activation
 * is otherwise left to pi, which activates names new to its registry and
 * applies the user's tool allow and deny lists; the adapter only restores
 * names it deactivated itself.
 */
export class McpToolSet {
  private provided = new Map<string, McpTool>()
  private deactivatedByUs = new Set<string>()

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly client: CastMcpClient,
    private readonly hooks: McpToolSetHooks,
  ) {}

  /** pi names of the tools currently provided by the server. */
  names(): string[] {
    return [...this.provided.keys()]
  }

  /** Replace the provided tools with a fresh discovery result. */
  apply(tools: McpTool[]): void {
    const next = new Map(tools.map((t) => [piToolName(t.name), t]))
    const vanished = [...this.provided.keys()].filter((name) => !next.has(name))
    this.provided = next

    for (const [name, tool] of next) this.pi.registerTool(this.definition(name, tool))

    const active = this.pi.getActiveTools()
    const available = new Set(this.pi.getAllTools().map((t) => t.name))
    const nextActive = active.filter((name) => !vanished.includes(name))
    for (const name of vanished) {
      if (active.includes(name)) this.deactivatedByUs.add(name)
    }
    for (const name of next.keys()) {
      if (!this.deactivatedByUs.delete(name)) continue
      if (available.has(name) && !nextActive.includes(name)) nextActive.push(name)
    }

    const changed =
      nextActive.length !== active.length || nextActive.some((name, i) => name !== active[i])
    if (changed) this.pi.setActiveTools(nextActive)
  }

  private definition(name: string, tool: McpTool): ToolDefinition<TSchema, McpResultDetails> {
    return {
      name,
      label: `mcp-cast ${tool.name}`,
      description: tool.description ?? `cast MCP tool ${tool.name}`,
      // MCP input schemas are plain JSON Schema, which pi validates natively.
      parameters: tool.inputSchema as unknown as TSchema,
      execute: async (_id, params, signal, _onUpdate, ctx) => {
        const current = this.provided.get(name)
        if (!current) {
          throw new Error(
            `${name} is no longer provided by the cast MCP server. ` +
              "Run /mcp-cast reconnect or use another tool.",
          )
        }
        let result: Record<string, unknown>
        try {
          result = await this.client.call(
            ctx.cwd,
            current.name,
            (params ?? {}) as Record<string, unknown>,
            signal,
          )
        } catch (error) {
          if (error instanceof McpClientError) {
            try {
              await this.hooks.onCallFailure(error)
            } catch {
              // The call error is what the model needs to see.
            }
          }
          throw error
        }
        return mapCallResult(current.name, result, this.hooks.mapOptions)
      },
    }
  }
}
