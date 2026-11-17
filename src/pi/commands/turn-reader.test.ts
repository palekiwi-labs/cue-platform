import { afterEach, describe, expect, test } from "bun:test"
import { setKittyProtocolActive } from "@earendil-works/pi-tui"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { SpeakResult } from "../speech"
import { COPY_KEY } from "../turn-reader/reader"
import { openTurnReader, READER_SHORTCUT, READER_SPEAK_KEY, registerTurnReader } from "./turn-reader"

const CTRL_U = "\x15"
const ESC = "\x1b"
const UP = "\x1b[A"
const DOWN = "\x1b[B"
const KEYS: Record<string, string> = { "tui.select.cancel": ESC, "tui.select.up": UP, "tui.select.down": DOWN }

function fakeCtx(branch: unknown[], idle = true, editorText = "", failSet = false, tagColors = false) {
  const editor = { text: editorText }
  const notes: string[] = []
  const levels: string[] = []
  const events: string[] = []
  const keys: string[] = []
  let rendered: string[] = []
  const frames: string[][] = []
  const tui = {
    terminal: { rows: 30 },
    requestRender: () => events.push("render"),
    showOverlay: () => ({ hide: () => events.push("backdrop hidden") }),
  }
  const theme = { fg: (c: unknown, s: string) => (tagColors ? `<${c}>${s}` : s), bold: (s: string) => s }
  const kb = { matches: (data: string, id: string) => KEYS[id] === data }
  const ctx = {
    hasUI: true,
    isIdle: () => idle,
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: (msg: string, level: string) => {
        notes.push(msg)
        levels.push(level)
      },
      getEditorText: () => editor.text,
      setEditorText: (text: string) => {
        if (failSet) throw new Error("no editor")
        editor.text = text
      },
      custom: async (factory: Function) => {
        let closed = false
        const component = factory(tui, theme, kb, () => {
          events.push("done")
          closed = true
        })
        rendered = component.render(60)
        for (const key of keys) {
          if (closed) break
          component.handleInput(key)
          await new Promise((resolve) => setTimeout(resolve, 0))
          frames.push(component.render(60))
        }
      },
    },
  } as unknown as ExtensionContext
  return { ctx, notes, levels, events, keys, frames, editor, rendered: () => rendered }
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

  test("with focus off s requests speech of the displayed text and reports it", async () => {
    const { ctx, notes, keys, rendered } = fakeCtx(turn)
    const s = speaker("sent")
    keys.push("f", READER_SPEAK_KEY, "q")
    await openTurnReader(ctx, s)
    expect(s.requests).toEqual([["answer"]])
    expect(notes).toEqual(["Speaking the latest turn"])
    expect(rendered().at(-1)).toContain("s speak")
  })

  test("s speaks the last message, or all after toggling with a", async () => {
    const two = [...turn, { type: "message", message: { role: "assistant", content: [{ type: "text", text: "more" }] } }]
    const last = fakeCtx(two)
    const s1 = speaker("sent")
    last.keys.push("f", READER_SPEAK_KEY, "q")
    await openTurnReader(last.ctx, s1)
    expect(s1.requests).toEqual([["more"]])

    const all = fakeCtx(two)
    const s2 = speaker("sent")
    all.keys.push("f", "a", READER_SPEAK_KEY, "q")
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
    keys.push(DOWN, "c", ..."note", "\r", READER_SPEAK_KEY, "f", READER_SPEAK_KEY, "q")
    await openTurnReader(ctx, s)
    expect(s.requests).toEqual([["two"], ["one\n\ntwo\n\nthree"]])
    expect(notes).toEqual(["Speaking the focused chunk", "Speaking the latest turn"])
    expect(frames[0]!.at(-1)).toContain("s speak chunk")
    expect(frames.at(-2)!.at(-1)).not.toContain("s speak chunk")
  })

  test("a refused chunk request is reported, as in a running snapshot", async () => {
    const { ctx, notes, keys, rendered } = fakeCtx([{ ...turn[0]!, id: "refused" }, chunked[1]], false)
    const s = speaker("busy")
    keys.push(READER_SPEAK_KEY, "q")
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
  test("opens focused on the first chunk; the arrows step and wrap; f toggles focus", async () => {
    const chunked = [
      { type: "message", id: "focus", message: { role: "user", content: "q" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "one\n\ntwo\n\nthree" }] } },
    ]
    const { ctx, keys, frames, rendered } = fakeCtx(chunked)
    keys.push(DOWN, UP, UP, DOWN, "f", DOWN, "f", "q")
    await openTurnReader(ctx)
    const head = (f: string[]) => /chunk \d\/\d/.exec(f[0]!)?.[0]
    expect(head(rendered())).toBe("chunk 1/3")
    expect(rendered().filter((l) => l.includes("\x1b[2m"))).toHaveLength(2)
    expect(frames.slice(0, 7).map(head)).toEqual([
      "chunk 2/3", "chunk 1/3", "chunk 3/3", "chunk 1/3", undefined, undefined, "chunk 1/3",
    ])
    expect(frames[0]!.filter((l) => l.includes("\x1b[2m"))).toHaveLength(2)
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

  for (const [name, altEnter] of [["tmux csi-u", "\x1b[13;3u"], ["xterm modifyOtherKeys", "\x1b[27;3;13~"]]) {
    test(`alt+enter as ${name} adds a comment newline without cancelling`, async () => {
      const { ctx, keys, editor } = fakeCtx(commentTurn("one"), true)
      keys.push("c", ...chars("ab"), altEnter, ...chars("cd"), ENTER, "r")
      await openTurnReader(ctx)
      expect(editor.text).toBe("> one\n\nab\ncd")
    })
  }

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

  test("the comment input box is drawn in the border color of the comment markers", async () => {
    const { ctx, keys, frames } = fakeCtx(commentTurn(), true, "", false, true)
    keys.push("c", ESC, "q")
    await openTurnReader(ctx)
    expect(hasLine(frames[0], "<border>───")).toBe(true)
    expect(hasLine(frames[0], "<accent>─")).toBe(false)
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
    running.keys.push("j", "c", ...chars("early"), ENTER, "q")
    await openTurnReader(running.ctx)
    expect(running.rendered()[0]).toContain("snapshot")
    handlers.agent_end!()

    const done = { type: "message", id: "done", message: { ...partial, content: [{ type: "text", text: "one\n\ntwo\n\nthree" }] } }
    const later = fakeCtx([userEntry, done], true, "")
    later.keys.push("r")
    await openTurnReader(later.ctx)
    expect(hasLine(later.rendered().map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")), "┃ early")).toBe(true)
    expect(later.editor.text).toBe("> tw\n\nearly")
  })
})

describe("comment navigation in the reader", () => {
  afterEach(() => setKittyProtocolActive(false))
  let turns = 0
  const navTurn = () => {
    const id = `nav-${++turns}`
    return [
      { type: "message", id, message: { role: "user", content: "q" } },
      {
        type: "message",
        id: `${id}-a`,
        message: { role: "assistant", content: [{ type: "text", text: "one\n\ntwo\n\nthree\n\nfour" }] },
      },
    ]
  }
  const head = (f: string[] | undefined) => /chunk \d\/\d/.exec(f?.[0] ?? "")?.[0]
  const setup = ["j", "c", "x", "\r", "j", "j", "c", "y", "\r"]

  const encodings: [string, string, string, boolean][] = [
    ["xterm", "\x1b[1;5A", "\x1b[1;5B", false],
    ["rxvt", "\x1bOa", "\x1bOb", false],
    ["kitty", "\x1b[1;5A", "\x1b[1;5B", true],
    ["kitty with press event type", "\x1b[1;5:1A", "\x1b[1;5:1B", true],
    ["kitty with caps lock", "\x1b[1;69A", "\x1b[1;69B", true],
  ]
  for (const [name, up, down, kitty] of encodings) {
    test(`ctrl+up and ctrl+down as ${name} jump between commented chunks, wrapping`, async () => {
      setKittyProtocolActive(kitty)
      const { ctx, keys, frames } = fakeCtx(navTurn())
      keys.push(...setup, down, down, up, "q")
      await openTurnReader(ctx)
      const jumps = frames.slice(setup.length, setup.length + 3)
      expect(jumps.map(head)).toEqual(["chunk 2/4", "chunk 4/4", "chunk 2/4"])
      expect(jumps[0]!.at(-1)).toContain(" comment 1/2 · wrapped ")
      expect(jumps[1]!.at(-1)).toContain(" comment 2/2 ")
      expect(jumps[2]!.at(-1)).toContain(" comment 1/2 ")
    })
  }

  test("plain and other modified arrows keep their meaning", async () => {
    const { ctx, keys, frames } = fakeCtx(navTurn())
    keys.push(...setup, UP, DOWN, "\x1b[1;2A", "\x1b[1;3A", "\x1b[1;6A", "q")
    await openTurnReader(ctx)
    const after = frames.slice(setup.length, setup.length + 5)
    expect(after.map(head)).toEqual(["chunk 3/4", "chunk 4/4", "chunk 4/4", "chunk 4/4", "chunk 4/4"])
    expect(after.some((f) => /comment \d\/\d|no comments/.test(f.at(-1)!))).toBe(false)
  })

  test("ctrl+arrows go to the comment editor while composing, not to navigation", async () => {
    const { ctx, keys, frames, events } = fakeCtx(navTurn())
    keys.push(...setup, "j", "c", "\x1b[1;5A", "\x1b[1;5B", "z", "\r", "q")
    await openTurnReader(ctx)
    const saved = frames.at(-2)!
    expect(head(saved)).toBe("chunk 1/4")
    expect(saved.some((l) => l.includes("┃ z"))).toBe(true)
    expect(events.filter((e) => e === "done")).toHaveLength(1)
  })

  test("with no comments ctrl+down reports it and keeps the reader open", async () => {
    const { ctx, keys, frames, notes, events } = fakeCtx(navTurn())
    keys.push("\x1b[1;5B", "j", "q")
    await openTurnReader(ctx)
    expect(head(frames[0])).toBe("chunk 1/4")
    expect(frames[0]!.at(-1)).toContain(" no comments (c comment) ")
    expect(frames[1]!.at(-1)).not.toContain("no comments")
    expect(notes).toEqual([])
    expect(events.filter((e) => e === "done")).toHaveLength(1)
  })

  test("with focus off ctrl+down turns focus on at a commented chunk", async () => {
    const { ctx, keys, frames } = fakeCtx(navTurn())
    keys.push(...setup, "f", "\x1b[1;5B", "q")
    await openTurnReader(ctx)
    expect(head(frames[setup.length])).toBeUndefined()
    expect(head(frames[setup.length + 1])).toBe("chunk 2/4")
  })
})

describe("copying from the reader", () => {
  const chunked = [turn[0], { type: "message", message: { role: "assistant", content: [{ type: "text", text: "one\n\ntwo\n\nthree" }] } }]
  function clipboard(error?: Error) {
    const copied: string[] = []
    const copy = async (text: string) => {
      if (error) throw error
      copied.push(text)
    }
    return { copied, copy }
  }

  test("y copies the focused chunk's source, not its comment, and keeps the reader open", async () => {
    const { ctx, keys, notes, events } = fakeCtx(chunked)
    const c = clipboard()
    keys.push("j", "c", ..."note", "\r", COPY_KEY, "j", COPY_KEY, "q")
    await openTurnReader(ctx, undefined, c.copy)
    expect(c.copied).toEqual(["two", "three"])
    expect(notes).toEqual(["Copied the focused chunk", "Copied the focused chunk"])
    expect(events.filter((e) => e === "done")).toHaveLength(1)
  })

  test("y does nothing with focus off", async () => {
    const { ctx, keys, notes, frames } = fakeCtx(chunked)
    const c = clipboard()
    keys.push("f", COPY_KEY, "q")
    await openTurnReader(ctx, undefined, c.copy)
    expect(c.copied).toEqual([])
    expect(notes).toEqual([])
    expect(frames[1]!.at(-1)).not.toContain(`${COPY_KEY} copy`)
  })

  test("a failed copy is reported as an error with its reason; the reader stays open", async () => {
    const { ctx, keys, notes, levels, events } = fakeCtx(chunked)
    keys.push(COPY_KEY, "q")
    await openTurnReader(ctx, undefined, clipboard(new Error("Clipboard unavailable")).copy)
    expect(notes).toEqual(["Could not copy the focused chunk: Clipboard unavailable"])
    expect(levels).toEqual(["error"])
    expect(events.filter((e) => e === "done")).toHaveLength(1)
  })

  test("a copy flashes copied in the footer until the next key restores the hints", async () => {
    const { ctx, keys, frames, events } = fakeCtx(chunked)
    const c = clipboard()
    keys.push(COPY_KEY, "j", COPY_KEY, "f", "q")
    await openTurnReader(ctx, undefined, c.copy)
    const foot = frames.map((f) => f.at(-1)!)
    expect(foot[0]).toContain(" copied ")
    expect(foot[0]).not.toContain(`${COPY_KEY} copy`)
    expect(foot[1]).not.toContain("copied")
    expect(foot[1]).toContain("f unfocus")
    expect(foot[2]).toContain(" copied ")
    expect(foot[3]).not.toContain("copied")
    expect(foot[3]).toContain("f focus")
    expect(c.copied).toEqual(["one", "two"])
    expect(events.filter((e) => e === "render")).toHaveLength(keys.length - 1 + 2)
  })

  test("a failed copy flashes its reason until the next key", async () => {
    const { ctx, keys, frames } = fakeCtx(chunked)
    keys.push(COPY_KEY, "j", "q")
    await openTurnReader(ctx, undefined, clipboard(new Error("Clipboard unavailable")).copy)
    expect(frames[0]!.at(-1)).toContain(" copy failed: Clipboard unavailable ")
    expect(frames[1]!.at(-1)).not.toContain("copy failed")
    expect(frames[1]!.at(-1)).toContain("f unfocus")
  })

  test("y types into the comment editor while composing", async () => {
    const { ctx, keys, frames } = fakeCtx(chunked)
    const c = clipboard()
    keys.push("c", COPY_KEY, "\r", "q")
    await openTurnReader(ctx, undefined, c.copy)
    expect(c.copied).toEqual([])
    expect(frames.at(-2)!.some((l) => l.includes("┃ y"))).toBe(true)
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
