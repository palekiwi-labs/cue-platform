import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent"
import { CUE_CONTEXT_TYPE } from "../lib/current-context"
import {
  injectArgs,
  parseAddress,
  parseInjectArgs,
  registerContextInjectCommand,
} from "./context-inject"

const dir = mkdtempSync(join(tmpdir(), "cue-inject-"))
const handoffFile = join(dir, "handoff-a.md")
writeFileSync(handoffFile, "# Selected state\n")
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const artifacts = [
  { path: handoffFile, name: "handoff-a.md", type: "trace", frontmatter: { created_at: 1 } },
  { path: join(dir, "missing.md"), name: "handoff-b.md", type: "trace", frontmatter: { created_at: 2 } },
]

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

describe("parseInjectArgs", () => {
  test("first word is the address, the rest an optional note", () => {
    expect(parseInjectArgs(" a/b/c ")).toEqual({ address: "a/b/c", note: undefined })
    expect(parseInjectArgs("a/b/c  see run 1 ")).toEqual({ address: "a/b/c", note: "see run 1" })
    expect(parseInjectArgs("a/b/c <pr>\nnumber: 1\n</pr>").note).toBe("<pr>\nnumber: 1\n</pr>")
    expect(parseInjectArgs("slug note").address).toBeUndefined()
  })

  test("--handoff after the address names one hand-off; the rest is the note", () => {
    expect(parseInjectArgs("a/b/c --handoff a/b/c/trace/handoff-x.md")).toEqual({
      address: "a/b/c", handoff: "a/b/c/trace/handoff-x.md", note: undefined,
    })
    expect(parseInjectArgs("a/b/c --handoff a/b/c/trace/h.md <pr>\nx\n</pr>")).toEqual({
      address: "a/b/c", handoff: "a/b/c/trace/h.md", note: "<pr>\nx\n</pr>",
    })
    expect(parseInjectArgs("a/b/c --handoff")).toEqual({ address: "a/b/c", missingHandoff: true })
    expect(parseInjectArgs("a/b/c --handoffs later").note).toBe("--handoffs later")
    expect(parseInjectArgs("a/b/c note --handoff x").handoff).toBeUndefined()
  })
})

describe("injectArgs", () => {
  test("round-trips through parseInjectArgs", () => {
    expect(injectArgs("a/b/c")).toBe("a/b/c")
    expect(injectArgs("a/b/c", { note: "n" })).toBe("a/b/c n")
    const args = injectArgs("a/b/c", { handoff: "a/b/c/trace/handoff-x.md", note: "two\nlines" })
    expect(parseInjectArgs(args)).toEqual({
      address: "a/b/c", handoff: "a/b/c/trace/handoff-x.md", note: "two\nlines",
    })
  })
})

function setup(opts: { exists?: boolean; idle?: boolean } = {}) {
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>
  const sent: { message: any; options: unknown }[] = []
  const notes: string[] = []
  const names: string[] = []
  const calls: string[][] = []
  const pi = {
    events: { emit() {} },
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
      const stdout = cmd === "cue" && args.join(" ") === "list --context x/y/other --frontmatter"
        ? JSON.stringify(artifacts)
        : ""
      return { stdout, stderr: "", code, killed: false }
    },
  } as unknown as ExtensionAPI
  const ctx = {
    cwd: "/w",
    isIdle: () => opts.idle ?? true,
    ui: { notify: (m: string) => notes.push(m) },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
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
    const rec = s.calls.find((a) => a[0] === "activity" && a[1] === "add")
    expect(rec).toContain("x/y/other")
    expect(rec).toContain('{"method":"inject"}')
  })

  test("appends a trailing note after the orientation", async () => {
    const s = setup()
    await s.run("x/y/other look at review/r1/")
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]!.message.content).toEndWith("\n\nlook at review/r1/")
  })

  test("injects exactly the selected hand-off between orientation and note", async () => {
    const s = setup()
    await s.run("x/y/other --handoff x/y/other/trace/handoff-a.md see run 1")
    expect(s.sent).toHaveLength(1)
    const content: string = s.sent[0]!.message.content
    expect(content).toContain(
      '<handoff address="x/y/other/trace/handoff-a.md" selected="true" entries-since="0">\n' +
        "# Selected state\n</handoff>\n\nsee run 1",
    )
    expect(content.match(/<handoff /g)).toHaveLength(1)
    const rec = s.calls.find((a) => a[0] === "activity" && a[1] === "add")
    expect(rec).toContain('{"method":"inject","handoff":"x/y/other/trace/handoff-a.md"}')
  })

  test("without --handoff no hand-off content is injected", async () => {
    const s = setup()
    await s.run("x/y/other")
    expect(s.sent[0]!.message.content).not.toContain("<handoff")
    expect(s.sent[0]!.message.content).not.toContain("Selected state")
  })

  test.each([
    ["from another context", "x/y/else/trace/handoff-a.md", "does not belong to context x/y/other"],
    ["not a hand-off", "x/y/other/trace/review.md", "is not a hand-off"],
    ["missing from the context", "x/y/other/trace/handoff-z.md", "no hand-off x/y/other/trace/handoff-z.md"],
    ["unreadable", "x/y/other/trace/handoff-b.md", "cannot read hand-off"],
  ])("hand-off %s: error notice, nothing sent", async (_n, handoff, message) => {
    const s = setup()
    await s.run(`x/y/other --handoff ${handoff}`)
    expect(s.sent).toHaveLength(0)
    expect(s.notes).toHaveLength(1)
    expect(s.notes[0]).toContain(message)
    expect(s.names).toEqual([])
  })

  test("--handoff without an address: usage notice, nothing sent", async () => {
    const s = setup()
    await s.run("x/y/other --handoff")
    expect(s.sent).toHaveLength(0)
    expect(s.notes[0]).toContain("--handoff")
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
