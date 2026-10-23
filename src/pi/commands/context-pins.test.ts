import { describe, expect, test } from "bun:test"
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent"
import {
  CUE_CONTEXT_TYPE,
  currentContext,
  slugOf,
} from "../lib/current-context"
import { parseTree } from "../lib/context-tree"
import { fuzzyNarrow } from "../lib/fuzzy-select"
import { pinItems, registerContextPinsCommand } from "./context-pins"

describe("current-context helpers", () => {
  test("parseTree walks nested roots with connectors, drops malformed", () => {
    const json = JSON.stringify({
      roots: [
        {
          context: "root",
          scope: "a/b",
          children: [
            { context: "mid", scope: "a/b", children: [{ context: "leaf", scope: "a/b" }] },
            { context: 3, scope: "a/b" },
          ],
        },
        { context: "solo", scope: "c/d" },
      ],
      diagnostics: [],
    })
    expect(parseTree(json).map((e) => [e.address, e.depth, e.isLast])).toEqual([
      ["a/b/root", 0, false],
      ["a/b/mid", 1, false],
      ["a/b/leaf", 2, true],
      ["c/d/solo", 0, true],
    ])
    expect(parseTree("{}")).toEqual([])
    expect(parseTree("not json")).toEqual([])
  })

  test("slugOf takes the last address segment", () => {
    expect(slugOf("palekiwi/palekiwi/cue-lsp")).toBe("cue-lsp")
  })

  test("currentContext returns the last injection on the branch", () => {
    const inj = (address: string) => ({
      type: "custom_message",
      customType: CUE_CONTEXT_TYPE,
      details: { address },
    })
    expect(currentContext([])).toBeUndefined()
    expect(
      currentContext([
        inj("a/b/first"),
        { type: "message" },
        inj("a/b/second"),
        { type: "custom_message", customType: "other", details: {} },
        { type: "custom_message", customType: CUE_CONTEXT_TYPE },
      ]),
    ).toBe("a/b/second")
  })

  test("currentContext: a link entry and an injection, newest wins", () => {
    const link = (address: string) => ({
      type: "custom",
      customType: CUE_CONTEXT_TYPE,
      data: { address },
    })
    const inj = (address: string) => ({
      type: "custom_message",
      customType: CUE_CONTEXT_TYPE,
      details: { address },
    })
    expect(currentContext([inj("a/b/one"), link("a/b/two")])).toBe("a/b/two")
    expect(currentContext([link("a/b/two"), inj("a/b/one")])).toBe("a/b/one")
    expect(
      currentContext([link("a/b/one"), { type: "custom", customType: "x" }]),
    ).toBe("a/b/one")
  })
})

const LIST_PINNED =
  "context tree --pinned --sort recency --json"

const pinsJson = (...slugs: string[]) =>
  JSON.stringify({
    roots: slugs.map((context) => ({ context, scope: "a/b" })),
    diagnostics: [],
  })

function setup(opts: {
  pins: string
  pick?: string
  action?: "submit" | "alt"
  idle?: boolean
}) {
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>
  const sent: { message: any; options: unknown }[] = []
  const notes: string[] = []
  const names: string[] = []
  const entries: { customType: string; data: unknown }[] = []
  let selectCalls = 0
  const pi = {
    registerShortcut: () => {},
    registerCommand: (_n: string, o: { handler: typeof handler }) => {
      handler = o.handler
    },
    sendMessage: (message: unknown, options?: unknown) => {
      sent.push({ message, options })
    },
    setSessionName: (n: string) => names.push(n),
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ customType, data }),
    exec: async (cmd: string, args: string[]) => {
      if (cmd === "cue" && args.join(" ") === LIST_PINNED) {
        return { stdout: opts.pins, stderr: "", code: 0, killed: false }
      }
      return { stdout: "", stderr: "", code: 1, killed: false }
    },
  } as unknown as ExtensionAPI
  const ctx = {
    cwd: "/w",
    isIdle: () => opts.idle ?? true,
    ui: {
      notify: (m: string) => notes.push(m),
      custom: async () => {
        selectCalls++
        return opts.pick
          ? { value: opts.pick, action: opts.action ?? "submit" }
          : null
      },
    },
  } as unknown as ExtensionCommandContext
  registerContextPinsCommand(pi)
  return {
    run: () => handler("", ctx),
    sent,
    notes,
    names,
    entries,
    selects: () => selectCalls,
  }
}

describe("/cue:context:pins", () => {
  test("injects the picked context without a turn", async () => {
    const s = setup({ pins: pinsJson("one", "two"), pick: "a/b/two" })
    await s.run()
    expect(s.sent).toHaveLength(1)
    const { message, options } = s.sent[0]!
    expect(options).toBeUndefined()
    expect(message.customType).toBe(CUE_CONTEXT_TYPE)
    expect(message.display).toBe(true)
    expect(message.details).toEqual({ address: "a/b/two" })
    expect(message.content).toContain("Active cue context for this session: two")
    expect(s.names).toEqual(["two"])
  })

  test("no pins: notifies, no picker", async () => {
    const s = setup({ pins: "[]" })
    await s.run()
    expect(s.selects()).toBe(0)
    expect(s.sent).toHaveLength(0)
    expect(s.notes).toHaveLength(1)
  })

  test("cancel is a no-op", async () => {
    const s = setup({ pins: pinsJson("one") })
    await s.run()
    expect(s.sent).toHaveLength(0)
  })

  test("refuses to inject while the agent is busy", async () => {
    const s = setup({ pins: pinsJson("one"), pick: "a/b/one", idle: false })
    await s.run()
    expect(s.sent).toHaveLength(0)
    expect(s.entries).toHaveLength(0)
    expect(s.notes).toHaveLength(1)
  })

  test("alt submit links without injecting, even while busy", async () => {
    const s = setup({
      pins: pinsJson("one", "two"),
      pick: "a/b/two",
      action: "alt",
      idle: false,
    })
    await s.run()
    expect(s.sent).toHaveLength(0)
    expect(s.entries).toEqual([
      { customType: CUE_CONTEXT_TYPE, data: { address: "a/b/two" } },
    ])
    expect(s.names).toEqual(["two"])
  })
})

describe("fuzzyNarrow", () => {
  const items = ["pi-session-naming", "pi-tmux-session-state", "cue-lsp"]
  test("empty query keeps the recency order", () => {
    expect(fuzzyNarrow(items, "")).toEqual(items)
  })
  test("fuzzy query narrows", () => {
    expect(fuzzyNarrow(items, "tmx")).toEqual(["pi-tmux-session-state"])
    expect(fuzzyNarrow(items, "clsp")).toEqual(["cue-lsp"])
  })
})

describe("pinItems tree", () => {
  const entry = (
    slug: string,
    depth: number,
    isLast: boolean,
    connectors: boolean[] = [],
  ) => ({ slug, address: `a/b/${slug}`, depth, connectors, isLast })

  test("indents with connectors", () => {
    const items = pinItems([
      entry("root", 0, false),
      entry("mid", 1, false),
      entry("leaf", 2, true, [true]),
      entry("other", 1, true),
      entry("solo", 0, true),
    ])
    expect(items.map((i) => i.label)).toEqual([
      "root",
      "├─mid",
      "│ └─leaf",
      "└─other",
      "solo",
    ])
    expect(items[2]).toMatchObject({ value: "a/b/leaf", text: "leaf" })
  })

  test("mixed scopes add a right column and scope haystack", () => {
    const items = pinItems([
      entry("root", 0, false),
      { slug: "ext", address: "x/y/ext", depth: 1, connectors: [], isLast: true },
    ])
    expect(items[0]).toMatchObject({ text: "root a/b/root", right: "a/b" })
    expect(items[1]).toMatchObject({ right: "x/y", text: "ext x/y/ext" })
  })
})
