import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { McpCastAdapter } from "./index"
import type { ConnectionState } from "./state"

export const STATUS_KEY = "mcp-cast"
export const COMMAND = "mcp-cast"
const SUBCOMMANDS = ["status", "reconnect"] as const

/** Footer text for a state; undefined clears the indicator. */
export function statusText(state: ConnectionState): string | undefined {
  switch (state.kind) {
    case "inactive":
      return undefined
    case "connecting":
      return "mcp-cast: connecting"
    case "connected":
      return `mcp-cast: ${state.toolCount} ${state.toolCount === 1 ? "tool" : "tools"}`
    case "unreachable":
      return `mcp-cast: unreachable (/${COMMAND} reconnect)`
  }
}

export function stateLine(state: ConnectionState): string {
  const at = (url?: string) => (url ? ` (${url})` : "")
  switch (state.kind) {
    case "inactive":
      return "cast MCP: not configured"
    case "connecting":
      return "cast MCP: connecting"
    case "connected":
      return `cast MCP: connected, ${state.toolCount} ${state.toolCount === 1 ? "tool" : "tools"}${at(state.url)}`
    case "unreachable":
      return `cast MCP: unreachable${at(state.url)}: ${state.error}`
  }
}

export function statusReport(state: ConnectionState, toolNames: string[]): string {
  const lines = [stateLine(state)]
  if (state.kind === "unreachable") {
    lines.push(`Run /${COMMAND} reconnect once the server is running.`)
  }
  if (toolNames.length > 0) {
    lines.push(`Registered tools (${toolNames.length}):`, ...toolNames.map((n) => `  ${n}`))
  }
  return lines.join("\n")
}

export function unreachableWarning(state: Extract<ConnectionState, { kind: "unreachable" }>): string {
  const at = state.url ? ` at ${state.url}` : ""
  return `cast MCP server unreachable${at}. Run /${COMMAND} reconnect once running.`
}

export function registerMcpCastCommand(pi: ExtensionAPI, adapter: McpCastAdapter): void {
  pi.registerCommand(COMMAND, {
    description: "cast MCP server: status | reconnect",
    getArgumentCompletions: (prefix) =>
      SUBCOMMANDS.filter((s) => s.startsWith(prefix.trim())).map((s) => ({
        value: s,
        label: s,
      })),
    handler: async (args, ctx) => {
      adapter.attach(ctx)
      const sub = args.trim() || "status"
      if (sub === "status") {
        ctx.ui.notify(statusReport(adapter.state, adapter.tools.names()), "info")
        return
      }
      if (sub === "reconnect") {
        await adapter.reconnect()
        const type = adapter.state.kind === "unreachable" ? "warning" : "info"
        ctx.ui.notify(stateLine(adapter.state), type)
        return
      }
      ctx.ui.notify(`Unknown subcommand "${sub}". Usage: /${COMMAND} status | reconnect`, "error")
    },
  })
}
