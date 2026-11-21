import { describe, expect, test } from "bun:test"
import extension from "../../../extensions/context-breakdown"
import { SNAPSHOT_TYPE } from "./snapshot"

type Handler = (event: unknown, ctx: unknown) => Promise<void>

function harness() {
  const handlers = new Map<string, Handler>()
  const commands = new Map<string, unknown>()
  const branch: { type: string; id: string; customType?: string; data?: unknown }[] = []
  let prompt = "<cwd>/a</cwd>"
  let active = ["read"]
  const pi = {
    on: (name: string, h: Handler) => handlers.set(name, h),
    registerCommand: (name: string, c: unknown) => commands.set(name, c),
    appendEntry: (customType: string, data: unknown) =>
      branch.push({ type: "custom", id: `c${branch.length}`, customType, data }),
    getActiveTools: () => active,
    getAllTools: () => [
      { name: "read", description: "r", parameters: {} },
      { name: "bash", description: "b", parameters: {} },
    ],
  }
  const ctx = {
    model: { provider: "p", id: "m", contextWindow: 1000 },
    getSystemPrompt: () => prompt,
    sessionManager: { getBranch: () => branch },
  }
  extension(pi as never)
  return {
    handlers,
    commands,
    branch,
    ctx,
    setPrompt: (p: string) => (prompt = p),
    setActive: (a: string[]) => (active = a),
  }
}

describe("context-breakdown extension", () => {
  test("registers /context", () => {
    expect(harness().commands.has("context")).toBe(true)
  })

  test("appends a snapshot only when the prefix changes", async () => {
    const h = harness()
    await h.handlers.get("session_start")!({}, h.ctx)
    await h.handlers.get("turn_start")!({}, h.ctx)
    expect(h.branch.filter((e) => e.customType === SNAPSHOT_TYPE)).toHaveLength(1)
    h.setActive(["read", "bash"])
    await h.handlers.get("turn_start")!({}, h.ctx)
    h.setPrompt("<cwd>/b</cwd>")
    await h.handlers.get("turn_start")!({}, h.ctx)
    await h.handlers.get("turn_start")!({}, h.ctx)
    expect(h.branch.filter((e) => e.customType === SNAPSHOT_TYPE)).toHaveLength(3)
  })
})
