import { describe, expect, test } from "bun:test"
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent"
import { CUE_CONTEXT_TYPE } from "../lib/current-context"
import {
  parseStatusAddress,
  registerContextCurrentCommand,
} from "./context-current"

describe("parseStatusAddress", () => {
  test("reads the address field", () => {
    expect(parseStatusAddress('{"address":"a/b/c"}')).toBe("a/b/c")
  })
  test("undefined on missing, empty or malformed", () => {
    expect(parseStatusAddress("")).toBeUndefined()
    expect(parseStatusAddress("{}")).toBeUndefined()
    expect(parseStatusAddress('{"address":""}')).toBeUndefined()
    expect(parseStatusAddress("active context: unset")).toBeUndefined()
  })
})

function setup(
  opts: { branch?: unknown[]; status?: string; idle?: boolean } = {},
) {
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>
  const sent: any[] = []
  const notes: string[] = []
  const calls: string[][] = []
  const pi = {
    registerCommand: (_n: string, o: { handler: typeof handler }) => {
      handler = o.handler
    },
    sendMessage: (message: unknown) => sent.push(message),
    setSessionName: () => {},
    exec: async (cmd: string, args: string[]) => {
      if (cmd === "cue") calls.push(args)
      const stdout =
        cmd === "cue" && args[0] === "status" && args[1] === "--json"
          ? (opts.status ?? "")
          : ""
      return { stdout, stderr: "", code: 0, killed: false }
    },
  } as unknown as ExtensionAPI
  const ctx = {
    cwd: "/w",
    isIdle: () => opts.idle ?? true,
    ui: { notify: (m: string) => notes.push(m) },
    sessionManager: { getBranch: () => opts.branch ?? [] },
  } as unknown as ExtensionCommandContext
  registerContextCurrentCommand(pi)
  return { run: () => handler("", ctx), sent, notes, calls }
}

describe("/cue:context:current", () => {
  test("session-linked context wins over cue status", async () => {
    const s = setup({
      branch: [
        { type: "custom", customType: CUE_CONTEXT_TYPE, data: { address: "x/y/linked" } },
      ],
      status: '{"address":"x/y/env"}',
    })
    await s.run()
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0].details).toEqual({ address: "x/y/linked" })
    expect(s.calls).not.toContainEqual(["status", "--json"])
  })

  test("falls back to cue status resolution", async () => {
    const s = setup({ status: '{"address":"x/y/env"}' })
    await s.run()
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0].customType).toBe(CUE_CONTEXT_TYPE)
    expect(s.sent[0].details).toEqual({ address: "x/y/env" })
    expect(s.sent[0].content).toContain(
      "Active cue context for this session: env",
    )
  })

  test("no active context: notice, nothing sent", async () => {
    const s = setup()
    await s.run()
    expect(s.sent).toHaveLength(0)
    expect(s.notes[0]).toContain("/cue:context:pins")
  })

  test("busy agent: notice, nothing sent", async () => {
    const s = setup({ status: '{"address":"x/y/env"}', idle: false })
    await s.run()
    expect(s.sent).toHaveLength(0)
    expect(s.notes).toHaveLength(1)
  })
})
