/** cast-mcp-client server name of the built-in cast MCP server. */
export const CAST_SERVER = "cast"

/**
 * Fixed prefix of every generated tool name. Matches the name opencode
 * derives for an MCP server keyed `cast`, so prompts and agent instructions
 * naming these tools work unchanged in both harnesses.
 */
export const TOOL_PREFIX = "mcp-cast_"

/** opencode's MCP name sanitizer: anything outside [a-zA-Z0-9_-] becomes `_`. */
export function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_")
}

export function piToolName(mcpToolName: string): string {
  return TOOL_PREFIX + sanitizeToolName(mcpToolName)
}
