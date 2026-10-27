import { describe, expect, test } from "bun:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { labelsInUse, lastMessageId, registerSessionLabel } from "./session-label"

const msg = (id: string, role: string) => ({ id, type: "message", message: { role } })

describe("lastMessageId", () => {
  test("skips non-message entries and tool results", () => {
    const branch = [
      msg("a", "user"),
      msg("b", "assistant"),
      msg("c", "toolResult"),
      { id: "d", type: "custom" },
    ]
    expect(lastMessageId(branch)).toBe("b")
  })

  test("undefined on an empty session", () => {
    expect(lastMessageId([{ id: "x", type: "model_change" }])).toBeUndefined()
  })
})

test("labelsInUse dedupes and sorts", () => {
  const labels: Record<string, string> = { a: "todo", b: "agent", c: "todo" }
  expect(labelsInUse([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }], (id) => labels[id]))
    .toEqual(["agent", "todo"])
})

function setup(branch: object[]) {
  const set: [string, string | undefined][] = []
  const notes: string[] = []
  let command: any
  const handlers: Record<string, Function> = {}
  const pi = {
    on: (name: string, h: Function) => (handlers[name] = h),
    registerCommand: (_n: string, c: unknown) => (command = c),
    setLabel: (id: string, l: string | undefined) => set.push([id, l]),
  } as unknown as ExtensionAPI
  registerSessionLabel(pi)
  const ctx = {
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => branch,
      getLabel: (id: string) => (id === "a" ? "old" : undefined),
    },
    ui: { notify: (m: string) => notes.push(m) },
  }
  return { set, notes, command, handlers, ctx }
}

describe("/label", () => {
  test("labels the last user or assistant message", async () => {
    const s = setup([msg("a", "user"), msg("b", "assistant")])
    await s.command.handler(" todo ", s.ctx)
    expect(s.set).toEqual([["b", "todo"]])
  })

  test("requires a name", async () => {
    const s = setup([msg("a", "user")])
    await s.command.handler("  ", s.ctx)
    expect(s.set).toEqual([])
    expect(s.notes[0]).toContain("usage")
  })

  test("completes labels in use, including newly set ones", async () => {
    const s = setup([msg("a", "user"), msg("b", "assistant")])
    await s.handlers.session_start({}, s.ctx)
    await s.command.handler("todo", s.ctx)
    expect(s.command.getArgumentCompletions("").map((i: any) => i.value)).toEqual(["old", "todo"])
    expect(s.command.getArgumentCompletions("t").map((i: any) => i.value)).toEqual(["todo"])
    expect(s.command.getArgumentCompletions("z")).toBeNull()
  })
})
