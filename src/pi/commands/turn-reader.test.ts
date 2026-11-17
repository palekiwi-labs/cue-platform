import { describe, expect, test } from "bun:test"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { SpeakResult } from "../speech"
import { openTurnReader, READER_SHORTCUT, READER_SPEAK_KEY, registerTurnReader } from "./turn-reader"

const CTRL_U = "\x15"
const ESC = "\x1b"
const UP = "\x1b[A"
const DOWN = "\x1b[B"
const KEYS: Record<string, string> = { "tui.select.cancel": ESC, "tui.select.up": UP, "tui.select.down": DOWN }

function fakeCtx(branch: unknown[], idle = true) {
  const notes: string[] = []
  const events: string[] = []
  const keys: string[] = []
  let rendered: string[] = []
  const frames: string[][] = []
  const tui = {
    terminal: { rows: 30 },
    requestRender: () => events.push("render"),
    showOverlay: () => ({ hide: () => events.push("backdrop hidden") }),
  }
  const theme = { fg: (_c: unknown, s: string) => s, bold: (s: string) => s }
  const kb = { matches: (data: string, id: string) => KEYS[id] === data }
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
          for (const key of keys) {
            component.handleInput(key)
            frames.push(component.render(60))
          }
        })
      },
    },
  } as unknown as ExtensionContext
  return { ctx, notes, events, keys, frames, rendered: () => rendered }
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

  for (const [name, key] of [["q", "q"], ["the shortcut", CTRL_U], ["escape", ESC]] as const) {
    test(`renders the turn text and closes on ${name}`, async () => {
      const { ctx, events, keys, rendered } = fakeCtx(turn)
      keys.push("j", key)
      await openTurnReader(ctx)
      expect(rendered().some((l) => l.includes("answer"))).toBe(true)
      expect(events).toEqual(["render", "backdrop hidden", "done"])
    })
  }
})

describe("speaking from the reader", () => {
  function speaker(result: SpeakResult) {
    const requests: (readonly string[])[] = []
    return { requests, request: (texts: readonly string[]) => (requests.push(texts), result) }
  }

  test("s requests speech of the displayed text and reports it", async () => {
    const { ctx, notes, keys, rendered } = fakeCtx(turn)
    const s = speaker("sent")
    keys.push(READER_SPEAK_KEY, "q")
    await openTurnReader(ctx, s)
    expect(s.requests).toEqual([["answer"]])
    expect(notes).toEqual(["Speaking the latest turn"])
    expect(rendered().at(-1)).toContain("s speak")
  })

  test("s speaks the last message, or all after toggling with a", async () => {
    const two = [...turn, { type: "message", message: { role: "assistant", content: [{ type: "text", text: "more" }] } }]
    const last = fakeCtx(two)
    const s1 = speaker("sent")
    last.keys.push(READER_SPEAK_KEY, "q")
    await openTurnReader(last.ctx, s1)
    expect(s1.requests).toEqual([["more"]])

    const all = fakeCtx(two)
    const s2 = speaker("sent")
    all.keys.push("a", READER_SPEAK_KEY, "q")
    await openTurnReader(all.ctx, s2)
    expect(s2.requests).toEqual([["answer", "more"]])
  })

  test("a refused request is reported", async () => {
    const { ctx, notes, keys } = fakeCtx(turn, false)
    keys.push(READER_SPEAK_KEY, "q")
    await openTurnReader(ctx, speaker("busy"))
    expect(notes).toEqual(["Speech request refused while the agent is running"])
  })

  test("without speech, s does nothing and no hint shows", async () => {
    const { ctx, notes, keys, rendered } = fakeCtx(turn)
    keys.push(READER_SPEAK_KEY, "q")
    await openTurnReader(ctx)
    expect(notes).toEqual([])
    expect(rendered().at(-1)).not.toContain("s speak")
  })
})


describe("chunk focus in the reader", () => {
  test("f toggles focus and the arrows step chunks only while focused", async () => {
    const chunked = [turn[0], { type: "message", message: { role: "assistant", content: [{ type: "text", text: "one\n\ntwo\n\nthree" }] } }]
    const { ctx, keys, frames } = fakeCtx(chunked)
    keys.push(DOWN, "f", DOWN, DOWN, UP, "f", "q")
    await openTurnReader(ctx)
    const heads = frames.slice(0, 6).map((f) => /chunk \d\/\d/.exec(f[0]!)?.[0])
    expect(heads).toEqual([undefined, "chunk 1/3", "chunk 2/3", "chunk 3/3", "chunk 2/3", undefined])
    expect(frames[2]!.filter((l) => l.includes("\x1b[2m"))).toHaveLength(2)
    expect(frames[5]!.some((l) => l.includes("\x1b[2m"))).toBe(false)
  })
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
    expect(READER_SHORTCUT).toBe("ctrl+u")
  })
})
