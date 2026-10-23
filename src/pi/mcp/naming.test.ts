import { describe, expect, test } from "bun:test"
import { piToolName, sanitizeToolName } from "./naming"

describe("piToolName", () => {
  test("prefixes plain names unchanged", () => {
    expect(piToolName("db_inspect_table")).toBe("mcp-cast_db_inspect_table")
  })

  test("keeps dashes and underscores", () => {
    expect(piToolName("spabreaks__run_rspec")).toBe("mcp-cast_spabreaks__run_rspec")
    expect(piToolName("a-b_c")).toBe("mcp-cast_a-b_c")
  })

  test("replaces characters outside [a-zA-Z0-9_-] with underscores", () => {
    expect(sanitizeToolName("ns.tool name/x:y")).toBe("ns_tool_name_x_y")
    expect(piToolName("ns.tool")).toBe("mcp-cast_ns_tool")
  })
})
