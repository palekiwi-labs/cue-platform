import { describe, expect, test } from "bun:test"
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent"
import { CUE_CONTEXT_TYPE } from "../lib/current-context"
import { parseAddress, registerContextInjectCommand } from "./context-inject"

describe("parseAddress", () => {
  test("accepts three segments, trims slashes and whitespace", () => {
    expect(parseAddress(" a/b/c ")).toBe("a/b/c")
    expect(parseAddress("/a/b/c/")).toBe("a/b/c")
  })
  test("rejects anything else", () => {
    expect(parseAddress("")).toBeUndefined()
    expect(parseAddress("slug")).toBeUndefined()
    expect(parseAddress("a/b")).toBeUndefined()
    expect(parseAddress("a/b/c/d")).toBeUndefined()
    expect(parseAddress("a/b c/d")).toBeUndefined()
  })
})

function setup(opts: { exists?: boolean; idle?: boolean } = {}) {
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>
  const sent: { message: any; options: unknown }[] = []
  const notes: string[] = []
  const names: string[] = []
  const calls: string[][] = []
  const pi = {
    registerCommand: (_n: string, o: { handler: typeof handler }) => {
      handler = o.handler
    },
    sendMessage: (message: unknown, options?: unknown) => {
      sent.push({ message, options })
    },
    setSessionName: (n: string) => names.push(n),
    exec: async (cmd: string, args: string[]) => {
      if (cmd === "cue") calls.push(args)
      const code =
        cmd === "cue" && args[0] === "status" && !(opts.exists ?? true) ? 1 : 0
      return { stdout: "", stderr: "", code, killed: false }
    },
  } as unknown as ExtensionAPI
  const ctx = {
    cwd: "/w",
    isIdle: () => opts.idle ?? true,
    ui: { notify: (m: string) => notes.push(m) },
  } as unknown as ExtensionCommandContext
  registerContextInjectCommand(pi)
  return { run: (a: string) => handler(a, ctx), sent, notes, names, calls }
}

describe("/cue:context:inject", () => {
  test("injects the addressed context, querying by full address", async () => {
    const s = setup()
    await s.run("x/y/other")
    expect(s.sent).toHaveLength(1)
    const { message, options } = s.sent[0]!
    expect(options).toBeUndefined()
    expect(message.customType).toBe(CUE_CONTEXT_TYPE)
    expect(message.details).toEqual({ address: "x/y/other" })
    expect(message.content).toContain(
      "Active cue context for this session: other",
    )
    expect(s.names).toEqual(["other"])
    expect(s.calls).toContainEqual(["status", "--context", "x/y/other"])
  })

  test("bad argument: usage notice, nothing sent", async () => {
    const s = setup()
    await s.run("other")
    expect(s.sent).toHaveLength(0)
    expect(s.notes).toHaveLength(1)
  })

  test("unknown context: error notice, nothing sent", async () => {
    const s = setup({ exists: false })
    await s.run("x/y/nope")
    expect(s.sent).toHaveLength(0)
    expect(s.notes[0]).toContain("x/y/nope")
  })

  test("refuses while the agent is busy", async () => {
    const s = setup({ idle: false })
    await s.run("x/y/other")
    expect(s.sent).toHaveLength(0)
    expect(s.notes).toHaveLength(1)
  })
})
