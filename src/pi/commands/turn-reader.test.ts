import { describe, expect, test } from "bun:test"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { openTurnReader, READER_SHORTCUT, registerTurnReader } from "./turn-reader"

const ALT_U = "\x1bu"
const ESC = "\x1b"

function fakeCtx(branch: unknown[], idle = true) {
  const notes: string[] = []
  const events: string[] = []
  const keys: string[] = []
  let rendered: string[] = []
  const tui = {
    terminal: { rows: 30 },
    requestRender: () => events.push("render"),
    showOverlay: () => ({ hide: () => events.push("backdrop hidden") }),
  }
  const theme = { fg: (_c: unknown, s: string) => s, bold: (s: string) => s }
  const kb = { matches: (data: string, id: string) => id === "tui.select.cancel" && data === ESC }
  const ctx = {
    hasUI: true,
    isIdle: () => idle,
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: (msg: string) => notes.push(msg),
      custom: async (factory: Function) => {
        await new Promise<void>((resolve) => {
          const component = factory(tui, theme, kb, () => {
            events.push("done")
            resolve()
          })
          rendered = component.render(60)
          for (const key of keys) component.handleInput(key)
        })
      },
    },
  } as unknown as ExtensionContext
  return { ctx, notes, events, keys, rendered: () => rendered }
}

const turn = [
  { type: "message", message: { role: "user", content: "q" } },
  {
    type: "message",
    message: { role: "assistant", content: [{ type: "toolCall" }, { type: "text", text: "answer" }] },
  },
]

describe("openTurnReader", () => {
  test("notifies instead of opening when the turn has no assistant text", async () => {
    const { ctx, notes, events } = fakeCtx([turn[0]])
    await openTurnReader(ctx)
    expect(notes).toEqual(["No assistant text in the latest turn yet"])
    expect(events).toEqual([])
  })

  for (const [name, key] of [["q", "q"], ["the shortcut", ALT_U], ["escape", ESC]] as const) {
    test(`renders the turn text and closes on ${name}`, async () => {
      const { ctx, events, keys, rendered } = fakeCtx(turn)
      keys.push("j", key)
      await openTurnReader(ctx)
      expect(rendered().some((l) => l.includes("answer"))).toBe(true)
      expect(events).toEqual(["render", "backdrop hidden", "done"])
    })
  }
})

describe("registerTurnReader", () => {
  test("registers the read command and the shortcut", () => {
    const commands: string[] = []
    const shortcuts: string[] = []
    const pi = {
      on: () => {},
      registerCommand: (name: string) => commands.push(name),
      registerShortcut: (key: string) => shortcuts.push(key),
    } as unknown as ExtensionAPI
    registerTurnReader(pi)
    expect(commands).toEqual(["cue:read"])
    expect(shortcuts).toEqual([READER_SHORTCUT])
    expect(READER_SHORTCUT).toBe("alt+u")
  })
})
