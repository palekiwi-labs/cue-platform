import { describe, expect, test } from "bun:test"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { SpeakResult } from "../speech"
import { openTurnReader, READER_SHORTCUT, READER_SPEAK_KEY, registerTurnReader } from "./turn-reader"

const CTRL_U = "\x15"
const ESC = "\x1b"
const UP = "\x1b[A"
const DOWN = "\x1b[B"
const KEYS: Record<string, string> = { "tui.select.cancel": ESC, "tui.select.up": UP, "tui.select.down": DOWN }

function fakeCtx(branch: unknown[], idle = true, editorText = "", failSet = false) {
  const editor = { text: editorText }
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
      getEditorText: () => editor.text,
      setEditorText: (text: string) => {
        if (failSet) throw new Error("no editor")
        editor.text = text
      },
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
  return { ctx, notes, events, keys, frames, editor, rendered: () => rendered }
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

  const chunked = [turn[0], { type: "message", message: { role: "assistant", content: [{ type: "text", text: "one\n\ntwo\n\nthree" }] } }]

  test("in focus mode s speaks only the focused chunk, not its comment", async () => {
    const { ctx, notes, keys, frames } = fakeCtx(chunked)
    const s = speaker("sent")
    keys.push("f", DOWN, "c", ..."note", "\r", READER_SPEAK_KEY, "f", READER_SPEAK_KEY, "q")
    await openTurnReader(ctx, s)
    expect(s.requests).toEqual([["two"], ["one\n\ntwo\n\nthree"]])
    expect(notes).toEqual(["Speaking the focused chunk", "Speaking the latest turn"])
    expect(frames[0]!.at(-1)).toContain("s speak chunk")
    expect(frames.at(-2)!.at(-1)).not.toContain("s speak chunk")
  })

  test("a refused chunk request is reported, as in a running snapshot", async () => {
    const { ctx, notes, keys, rendered } = fakeCtx(chunked, false)
    const s = speaker("busy")
    keys.push("f", READER_SPEAK_KEY, "q")
    await openTurnReader(ctx, s)
    expect(rendered()[0]).toContain("snapshot")
    expect(s.requests).toEqual([["one"]])
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
describe("chunk comments in the reader", () => {
  const ENTER = "\r"
  const chars = (s: string) => [...s]
  let turns = 0
  const commentTurn = (text = "one\n\ntwo") => {
    const id = `turn-${++turns}`
    return [
      { type: "message", id, message: { role: "user", content: "q" } },
      { type: "message", id: `${id}-a`, message: { role: "assistant", content: [{ type: "text", text }] } },
    ]
  }
  const hasLine = (frame: string[] | undefined, s: string) => frame?.some((l) => l.includes(s)) ?? false

  test("r appends the quoted chunks and comments after the editor text, then closes", async () => {
    const { ctx, keys, editor, notes, events } = fakeCtx(commentTurn(), true, "my draft")
    keys.push("c", ...chars("first"), ENTER, "j", "c", ...chars("second"), ENTER, "r")
    await openTurnReader(ctx)
    expect(editor.text).toBe("my draft\n\n> one\n\nfirst\n\n> two\n\nsecond")
    expect(notes).toEqual(["Inserted 2 comments into the editor"])
    expect(events.at(-1)).toBe("done")
  })

  test("comments are visible inline and inserting never sends", async () => {
    const { ctx, keys, frames, editor } = fakeCtx(commentTurn(), true)
    keys.push("c", ...chars("hi"), ENTER, "r")
    await openTurnReader(ctx)
    const saved = frames.at(-2)!
    expect(hasLine(saved, "┃ hi")).toBe(true)
    expect(saved[0]).toContain("1 comment")
    expect(editor.text).toBe("> one\n\nhi")
  })

  test("a failed insert keeps the drafts, the editor text and the reader open", async () => {
    const branch = commentTurn()
    const first = fakeCtx(branch, true, "keep", true)
    first.keys.push("c", ...chars("note"), ENTER, "r", "q")
    await openTurnReader(first.ctx)
    expect(first.editor.text).toBe("keep")
    expect(first.notes).toEqual(["Could not insert comments (no editor); drafts kept"])
    expect(first.events.filter((e) => e === "done")).toHaveLength(1)
    expect(hasLine(first.frames.at(-2), "┃ note")).toBe(true)

    const retry = fakeCtx(branch, true, "keep")
    retry.keys.push("r")
    await openTurnReader(retry.ctx)
    expect(retry.editor.text).toBe("keep\n\n> one\n\nnote")
  })

  test("r without comments notifies and stays open", async () => {
    const { ctx, keys, notes, editor, events } = fakeCtx(commentTurn(), true, "x")
    keys.push("r", "q")
    await openTurnReader(ctx)
    expect(notes).toEqual(["No comments to insert"])
    expect(editor.text).toBe("x")
    expect(events).toEqual(["render", "backdrop hidden", "done"])
  })

  test("drafts survive closing and reopening the same turn, not a new turn", async () => {
    const branch = commentTurn()
    const first = fakeCtx(branch)
    first.keys.push("c", ...chars("kept"), ENTER, "q")
    await openTurnReader(first.ctx)
    const again = fakeCtx(branch)
    again.keys.push("q")
    await openTurnReader(again.ctx)
    expect(hasLine(again.rendered(), "┃ kept")).toBe(true)
    const other = fakeCtx(commentTurn())
    other.keys.push("q")
    await openTurnReader(other.ctx)
    expect(hasLine(other.rendered(), "┃ kept")).toBe(false)
  })

  test("esc cancels composing without closing; c resumes the unsaved text", async () => {
    const { ctx, keys, frames, events } = fakeCtx(commentTurn())
    keys.push("c", ...chars("half"), ESC, "c", ENTER, ESC)
    await openTurnReader(ctx)
    const afterCancel = frames[5]!
    expect(afterCancel.at(-1)).not.toContain("esc cancel")
    expect(hasLine(afterCancel, "half")).toBe(false)
    expect(hasLine(frames[6], "half")).toBe(true)
    expect(hasLine(frames[7], "┃ half")).toBe(true)
    expect(events.filter((e) => e === "done")).toHaveLength(1)
  })

  test("keys go to the comment editor while composing", async () => {
    const { ctx, keys, frames, events } = fakeCtx(commentTurn())
    keys.push("c", "q", "a", "r", "d", ENTER, "q")
    await openTurnReader(ctx)
    expect(events.filter((e) => e === "done")).toHaveLength(1)
    expect(frames.at(-2)!.at(-1)).toContain("d delete")
    expect(hasLine(frames.at(-2), "┃ qard")).toBe(true)
  })

  test("d deletes the focused comment", async () => {
    const { ctx, keys, frames } = fakeCtx(commentTurn())
    keys.push("c", ...chars("gone"), ENTER, "d", "q")
    await openTurnReader(ctx)
    expect(hasLine(frames.at(-3), "┃ gone")).toBe(true)
    expect(hasLine(frames.at(-2), "┃ gone")).toBe(false)
  })

  test("a snapshot comment stays on its chunk when the turn has grown, quoting what was read", async () => {
    const [userEntry] = commentTurn()
    const partial = { role: "assistant", content: [{ type: "text", text: "one\n\ntw" }], timestamp: 7 }
    const pi = { on: (name: string, h: Function) => (handlers[name] = h), registerCommand() {}, registerShortcut() {} }
    const handlers: Record<string, Function> = {}
    registerTurnReader(pi as unknown as ExtensionAPI)
    handlers.message_start!({ message: partial })
    const running = fakeCtx([userEntry], false)
    running.keys.push("f", "j", "c", ...chars("early"), ENTER, "q")
    await openTurnReader(running.ctx)
    expect(running.rendered()[0]).toContain("snapshot")
    handlers.agent_end!()

    const done = { type: "message", id: "done", message: { ...partial, content: [{ type: "text", text: "one\n\ntwo\n\nthree" }] } }
    const later = fakeCtx([userEntry, done], true, "")
    later.keys.push("r")
    await openTurnReader(later.ctx)
    expect(hasLine(later.rendered(), "┃ early")).toBe(true)
    expect(later.editor.text).toBe("> tw\n\nearly")
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
