import { afterEach, describe, expect, test } from "bun:test"
import type { MarkdownTheme } from "@earendil-works/pi-tui"
import { latestTurnTexts } from "./latest-turn"
import { Editor, setKittyProtocolActive, visibleWidth } from "@earendil-works/pi-tui"
import { TurnComments } from "./comments"
import { COPY_KEY, faint, FOCUS_KEY, MODE_KEY, readerHeight, readerWidth, TEXT_WIDTH, TurnReader } from "./reader"

const user = (text: string) => ({ type: "message", message: { role: "user", content: text } })
const assistant = (timestamp: number, ...parts: { type: string; text?: string }[]) => ({
  type: "message",
  message: { role: "assistant", content: parts, timestamp },
})
const toolResult = () => ({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "out" }] } })
const text = (t: string) => ({ type: "text", text: t })

describe("latestTurnTexts", () => {
  test("keeps each assistant message after the latest user message, text only", () => {
    const texts = latestTurnTexts([
      user("first"),
      assistant(1, text("old")),
      user("second"),
      assistant(2, { type: "thinking", thinking: "hmm" } as never, text("one")),
      assistant(3, { type: "toolCall" }),
      toolResult(),
      assistant(4, text("two"), { type: "toolCall" }, text("three")),
      { type: "custom", message: undefined },
    ])
    expect(texts).toEqual(["one", "two\n\nthree"])
  })

  test("is empty without a user message or assistant text", () => {
    expect(latestTurnTexts([assistant(1, text("x"))])).toEqual([])
    expect(latestTurnTexts([user("q"), assistant(1, { type: "toolCall" })])).toEqual([])
  })

  test("adds the streaming message unless the branch already holds it", () => {
    const branch = [user("q"), assistant(1, text("done"))]
    const live = { role: "assistant", content: [text("partial")], timestamp: 2 }
    expect(latestTurnTexts(branch, live)).toEqual(["done", "partial"])
    expect(latestTurnTexts(branch, { ...live, timestamp: 1 })).toEqual(["done"])
  })
})

const plain = { fg: (_c: unknown, s: string) => s, bold: (s: string) => s }
const id = (s: string) => s
const md: MarkdownTheme = {
  heading: id, link: id, linkUrl: id, code: id, codeBlock: id, codeBlockBorder: id, quote: id,
  quoteBorder: id, hr: id, listBullet: id, bold: id, italic: id, strikethrough: id, underline: id,
}

describe("TurnReader", () => {
  test("width targets the text width and is capped to the terminal", () => {
    expect(readerWidth(200)).toBe(TEXT_WIDTH + 6)
    expect(readerWidth(50)).toBe(50)
  })

  test("shows the last message by default, sized to content", () => {
    const reader = new TurnReader(plain, md, ["# Title\n\nbody", "second"], () => 40)
    const lines = reader.render(60)
    expect(lines[0]).toStartWith("╭─ latest turn · last of 2 messages · chunk 1/1 ")
    expect(lines.slice(1, -1).map((l) => l.slice(1, -1).trim())).toEqual(["", "second", ""])
    expect(lines.at(-1)).toContain(`${MODE_KEY} all · ${FOCUS_KEY} unfocus`)
    expect(reader.shown()).toEqual(["second"])
    expect(lines.every((l) => l.length === 60)).toBe(true)
  })

  test("toggles to all messages as markdown, separated by a rule, and back", () => {
    const reader = new TurnReader(plain, md, ["# Title\n\nbody", "second"], () => 40)
    reader.toggleFocus()
    reader.toggle()
    const lines = reader.render(40)
    expect(lines[0]).toStartWith("╭─ latest turn · all 2 messages ")
    expect(lines.slice(1, -1).map((l) => l.slice(1, -1).trim())).toEqual([
      "", "Title", "", "body", "", "---", "", "second", "",
    ])
    expect(lines.at(-1)).toContain(`${MODE_KEY} last · ${FOCUS_KEY} focus · esc close`)
    expect(reader.shown()).toEqual(["# Title\n\nbody", "second"])
    reader.toggle()
    expect(reader.render(40)[0]).toContain("last of 2 messages")
  })

  test("draws the frame in the muted border color", () => {
    const tagged = { fg: (c: string, s: string) => `<${c}>${s}`, bold: (s: string) => s }
    const lines = new TurnReader(tagged, md, ["text"], () => 40).render(40)
    expect(lines[0]).toStartWith("<borderMuted>╭─")
    expect(lines[1]).toStartWith("<borderMuted>│")
    expect(lines.join("")).not.toContain("<border>")
  })

  test("a single message has no mode toggle", () => {
    const reader = new TurnReader(plain, md, ["only"], () => 40)
    reader.toggle()
    const lines = reader.render(40)
    expect(lines[0]).toStartWith("╭─ latest turn · 1 message ")
    expect(lines.at(-1)).not.toContain(`${MODE_KEY} all`)
    expect(reader.shown()).toEqual(["only"])
  })

  test("hints the speak key only when speech is available", () => {
    expect(new TurnReader(plain, md, ["text"], () => 40, false, true).render(60).at(-1)).toContain("s speak chunk · f unfocus")
    expect(new TurnReader(plain, md, ["text"], () => 40).render(40).at(-1)).not.toContain("s speak")
  })

  test("wraps prose to the inner width", () => {
    const reader = new TurnReader(plain, md, ["word ".repeat(30).trim()], () => 40)
    const body = reader.render(26).slice(2, -2)
    expect(body.length).toBeGreaterThan(1)
    expect(body.every((l) => l.length === 26)).toBe(true)
  })

  test("scrolls by line, page, top and bottom within the viewport", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n\n")
    const reader = new TurnReader(plain, md, [lines], () => 16, true)
    reader.toggleFocus()
    const view = () => reader.render(40)
    expect(reader.viewport()).toBe(8)
    expect(view()).toHaveLength(12)
    expect(view()[0]).toContain("snapshot")
    expect(view()[2]).toContain("line 1")
    expect(view().at(-1)).toContain("1-8/59")
    reader.scroll(2)
    expect(view()[2]).toContain("line 2")
    reader.page(1)
    expect(view().at(-1)).toContain("10-17/59")
    reader.bottom()
    expect(view()[9]).toContain("line 30")
    expect(view().at(-1)).toContain("52-59/59")
    reader.scroll(5)
    expect(view().at(-1)).toContain("52-59/59")
    reader.top()
    reader.scroll(-3)
    expect(view().at(-1)).toContain("1-8/59")
  })

  test("height is capped at three quarters of the terminal", () => {
    expect(readerHeight(40)).toBe(30)
    expect(readerHeight(41)).toBe(30)
    const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n\n")
    expect(new TurnReader(plain, md, [long], () => 40).render(40)).toHaveLength(30)
  })

  test("small terminals drop the padding rows but keep borders and a body row", () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n\n")
    const at = (rows: number) => new TurnReader(plain, md, [long], () => rows).render(40)
    expect(readerHeight(6)).toBe(4)
    expect(at(6)).toHaveLength(4)
    expect(at(6)[1]).toContain("line 0")
    expect(at(8)).toHaveLength(6)
    expect(at(8)[1].trim()).toBe("│" + " ".repeat(38) + "│")
    for (const rows of [1, 3, 4, 5]) {
      const lines = at(rows)
      expect(lines).toHaveLength(3)
      expect(lines[1]).toContain("line 0")
    }
  })
})

describe("TurnReader chunk focus", () => {
  const SGR = /\x1b\[[0-9;]*m/g
  const text = (l: string) => l.replace(SGR, "").slice(1, -1).trim()
  const isFaint = (l: string) => l.includes("\x1b[2m")
  const body = (lines: string[]) => lines.slice(2, -2)
  const focusedText = (lines: string[]) => body(lines).filter((l) => text(l) !== "" && !isFaint(l)).map(text)
  const paragraphs = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n\n")

  test("faint keeps the attribute across nested styles", () => {
    expect(faint("\x1b[1mA\x1b[22mB")).toBe("\x1b[2m\x1b[1m\x1b[2mA\x1b[22m\x1b[2mB\x1b[22m")
  })

  test("starts focused on the first chunk with the view at the top", () => {
    const reader = new TurnReader(plain, md, [paragraphs(30)], () => 16)
    const lines = reader.render(60)
    expect(reader.focused()).toBe(true)
    expect(lines[0]).toContain("chunk 1/30")
    expect(focusedText(lines)).toEqual(["line 1"])
    expect(text(body(lines)[0]!)).toBe("line 1")
    expect(lines.at(-1)).toContain("1-8/59")
    expect(lines.at(-1)).toContain(`${FOCUS_KEY} unfocus`)
  })

  test("f clears focus with nothing dimmed, f again focuses the first chunk", () => {
    const reader = new TurnReader(plain, md, ["# Title\nintro\n\nsecond\n\nthird"], () => 40)
    reader.render(60)
    reader.toggleFocus()
    const off = reader.render(60)
    expect(reader.focused()).toBe(false)
    expect(off.some(isFaint)).toBe(false)
    expect(off[0]).not.toContain("chunk")
    expect(off.at(-1)).toContain(`${FOCUS_KEY} focus · esc close`)
    reader.toggleFocus()
    const lines = reader.render(60)
    expect(lines[0]).toContain("latest turn · 1 message · chunk 1/3")
    expect(focusedText(lines)).toEqual(["Title", "intro"])
    expect(body(lines).filter(isFaint).map(text)).toEqual(["second", "third"])
    expect(lines.at(-1)).toContain(`${FOCUS_KEY} unfocus · ${COPY_KEY} copy · c comment · ↑↓ chunk · esc`)
    reader.toggleFocus()
    expect(reader.render(60).some(isFaint)).toBe(false)
  })

  test("a wrapped chunk is focused on every line", () => {
    const long = "word ".repeat(30).trim()
    const reader = new TurnReader(plain, md, [`${long}\n\nafter`], () => 40)
    const lines = reader.render(26)
    const focused = focusedText(lines)
    expect(focused.length).toBeGreaterThan(1)
    expect(focused.join(" ")).toBe(long)
    expect(body(lines).filter(isFaint).map(text)).toEqual(["after"])
  })

  test("arrows step chunks and scroll the focused chunk into view", () => {
    const reader = new TurnReader(plain, md, [paragraphs(30)], () => 16)
    const view = () => reader.render(60)
    view()
    for (let i = 0; i < 5; i++) reader.move(1)
    expect(view()[0]).toContain("chunk 6/30")
    expect(focusedText(view())).toEqual(["line 6"])
    expect(text(body(view()).at(-1)!)).toBe("line 6")
    expect(view().at(-1)).toContain("4-11/59")
    for (let i = 0; i < 4; i++) reader.move(-1)
    expect(text(body(view())[0]!)).toBe("line 2")
    reader.move(-1)
    expect(view()[0]).toContain("chunk 1/30")
    expect(view().at(-1)).toContain("1-8/59")
  })

  test("stepping wraps from the first chunk to the last and back", () => {
    const reader = new TurnReader(plain, md, [paragraphs(30)], () => 16)
    const view = () => reader.render(60)
    view()
    reader.move(-1)
    expect(view()[0]).toContain("chunk 30/30")
    expect(focusedText(view())).toEqual(["line 30"])
    expect(view().at(-1)).toContain("52-59/59")
    reader.move(1)
    expect(view()[0]).toContain("chunk 1/30")
    expect(focusedText(view())).toEqual(["line 1"])
    expect(view().at(-1)).toContain("1-8/59")
  })

  test("a single chunk stays focused when stepping either way", () => {
    const reader = new TurnReader(plain, md, ["only"], () => 40)
    reader.render(60)
    reader.move(1)
    expect(reader.render(60)[0]).toContain("chunk 1/1")
    reader.move(-1)
    const lines = reader.render(60)
    expect(lines[0]).toContain("chunk 1/1")
    expect(focusedText(lines)).toEqual(["only"])
  })

  test("without chunks focus mode shows no chunk and offers no chunk keys", () => {
    const reader = new TurnReader(plain, md, ["[a]: http://x"], () => 40)
    const lines = reader.render(60)
    expect(reader.focused()).toBe(true)
    expect(lines[0]).not.toContain("chunk")
    expect(lines.at(-1)).toContain(`${FOCUS_KEY} unfocus`)
    expect(lines.at(-1)).not.toContain("comment")
    expect(lines.at(-1)).not.toContain("chunk")
    expect(lines.at(-1)).not.toContain(`${COPY_KEY} copy`)
    reader.move(1)
    reader.move(-1)
    expect(reader.render(60)).toEqual(lines)
    expect(reader.focusedSource()).toBeUndefined()
    expect(reader.spoken()).toEqual([])
  })

  test("outside focus mode the arrows scroll by line", () => {
    const reader = new TurnReader(plain, md, [paragraphs(30)], () => 16)
    reader.render(60)
    reader.toggleFocus()
    reader.move(1)
    reader.move(1)
    expect(reader.render(60).at(-1)).toContain("3-10/59")
  })

  test("manual scrolling holds until the next chunk step", () => {
    const reader = new TurnReader(plain, md, [paragraphs(30)], () => 16)
    reader.render(60)
    reader.page(1)
    expect(reader.render(60).at(-1)).toContain("8-15/59")
    expect(reader.render(60).at(-1)).toContain("8-15/59")
    expect(reader.render(60)[0]).toContain("chunk 1/30")
    reader.bottom()
    expect(reader.render(60).at(-1)).toContain("52-59/59")
    reader.move(1)
    const lines = reader.render(60)
    expect(lines[0]).toContain("chunk 2/30")
    expect(text(body(lines)[0]!)).toBe("line 2")
  })

  test("turning focus on picks the first chunk in view", () => {
    const reader = new TurnReader(plain, md, [paragraphs(30)], () => 16)
    reader.render(60)
    reader.toggleFocus()
    reader.scroll(5)
    reader.toggleFocus()
    const lines = reader.render(60)
    expect(lines[0]).toContain("chunk 4/30")
    expect(lines.at(-1)).toContain("6-13/59")
  })

  test("a chunk taller than the viewport is aligned to its top", () => {
    const tall = Array.from({ length: 12 }, (_, i) => `row ${i}`).join("\n")
    const reader = new TurnReader(plain, md, ["intro\n\n```\n" + tall + "\n```\n\nend"], () => 16)
    reader.render(60)
    reader.move(1)
    const lines = reader.render(60)
    expect(text(body(lines)[0]!)).toBe("```")
    expect(body(lines).some(isFaint)).toBe(false)
  })

  test("a fenced block with blank lines is a single chunk", () => {
    const reader = new TurnReader(plain, md, ["```\na\n\nb\n```\n\nafter"], () => 40)
    const lines = reader.render(60)
    expect(lines[0]).toContain("chunk 1/2")
    expect(focusedText(lines)).toEqual(["```", "a", "b", "```"])
  })

  test("list numbering and continuation indent survive chunking", () => {
    const reader = new TurnReader(plain, md, ["1. Step\n\n   More\n\n2. Next"], () => 40)
    reader.toggleFocus()
    const rows = body(reader.render(60)).map((l) => l.slice(3, -3).trimEnd())
    expect(rows).toEqual(["1. Step", "", "   More", "", "2. Next"])
  })

  test("chunks run across messages and the rule is dimmed", () => {
    const reader = new TurnReader(plain, md, ["a1\n\na2", "b1"], () => 40)
    reader.toggle()
    reader.render(60)
    reader.move(1)
    reader.move(1)
    const lines = reader.render(60)
    expect(lines[0]).toContain("chunk 3/3")
    expect(focusedText(lines)).toEqual(["b1"])
    expect(body(lines).filter(isFaint).map(text)).toEqual(["a1", "a2", "---"])
    reader.toggle()
    expect(reader.render(60)[0]).toContain("chunk 1/1")
  })

  test("the all/last toggle keeps focus and returns to the first chunk at the top", () => {
    const reader = new TurnReader(plain, md, [paragraphs(20), paragraphs(3)], () => 16)
    reader.toggle()
    reader.render(60)
    reader.move(-1)
    expect(reader.render(60)[0]).toContain("chunk 23/23")
    reader.toggle()
    const last = reader.render(60)
    expect(last[0]).toContain("last of 2 messages · chunk 1/3")
    expect(focusedText(last)).toEqual(["line 1"])
    reader.move(-1)
    reader.toggle()
    const all = reader.render(86)
    expect(all[0]).toContain("all 2 messages · chunk 1/23")
    expect(text(body(all)[0]!)).toBe("line 1")
    expect(all.at(-1)).toContain("1-8/")
  })
})

describe("TurnReader chunk comments", () => {
  const SGR = /\x1b\[[0-9;]*m|\x1b_pi:c\x07/g
  const strip = (l: string) => l.replace(SGR, "")
  const fakeTui = { terminal: { rows: 40 }, requestRender: () => {} }
  const editor = () => new Editor(fakeTui as never, { borderColor: id, selectList: {} as never })
  const type = (reader: TurnReader, s: string) => {
    for (const ch of s) reader.composeInput(ch)
  }
  const open = (messages: string[], comments = new TurnComments(), rows = 40) => {
    const reader = new TurnReader(plain, md, messages, () => rows, false, false, comments)
    reader.render(60)
    return reader
  }

  describe("alt+enter inserts a newline in every terminal encoding", () => {
    afterEach(() => setKittyProtocolActive(false))
    const variants: [string, string, boolean][] = [
      ["legacy ESC CR", "\x1b\r", false],
      ["legacy ESC CR under the kitty protocol", "\x1b\r", true],
      ["kitty / tmux csi-u", "\x1b[13;3u", false],
      ["kitty / tmux csi-u under the kitty protocol", "\x1b[13;3u", true],
      ["kitty csi-u with press event type", "\x1b[13;3:1u", true],
      ["xterm modifyOtherKeys", "\x1b[27;3;13~", false],
    ]
    for (const [name, data, kitty] of variants) {
      test(name, () => {
        setKittyProtocolActive(kitty)
        const comments = new TurnComments()
        const reader = open(["one"], comments)
        reader.comment(editor())
        type(reader, "ab")
        reader.composeInput(data)
        type(reader, "cd")
        expect(reader.composing()).toBe(true)
        reader.composeInput("\r")
        expect(comments.entries()).toEqual([["0:0", { quote: "one", text: "ab\ncd" }]])
      })
    }
  })

  test("c composes on the focused chunk and enter saves it inline under the chunk", () => {
    const comments = new TurnComments()
    const reader = open(["one\n\ntwo"], comments)
    reader.move(1)
    reader.render(60)
    expect(reader.comment(editor())).toBe(true)
    type(reader, "why two?")
    const composing = reader.render(60).map(strip)
    expect(reader.composing()).toBe(true)
    expect(composing.at(-1)).toContain("enter save · alt+enter newline · esc cancel")
    expect(composing.some((l) => l.includes("why two?"))).toBe(true)
    reader.composeInput("\r")
    expect(reader.composing()).toBe(false)
    expect(comments.entries()).toEqual([["0:1", { quote: "two", text: "why two?" }]])
    expect(reader.render(60).map(strip)).toEqual([
      "╭─ latest turn · 1 message · chunk 2/2 · 1 comment ────────╮",
      "│" + " ".repeat(58) + "│",
      "│  one" + " ".repeat(53) + "│",
      "│" + " ".repeat(58) + "│",
      "│  two" + " ".repeat(53) + "│",
      "│" + " ".repeat(58) + "│",
      "│  ┃ comment" + " ".repeat(47) + "│",
      "│  ┃ why two?" + " ".repeat(46) + "│",
      "│" + " ".repeat(58) + "│",
      "╰─────── f unfocus · c comment · d delete · r reply · esc ─╯",
    ])
  })

  test("the comment is dimmed with its chunk and shown below it in the frame", () => {
    const comments = new TurnComments()
    comments.save("0:0", "one", "note on one")
    const reader = open(["one\n\ntwo"], comments)
    reader.move(1)
    const lines = reader.render(60)
    const row = lines.find((l) => strip(l).includes("note on one"))!
    expect(row).toContain("\x1b[2m")
    expect(lines.at(-1)).toContain("f unfocus · c comment · r reply · ↑↓ chunk · esc")
    expect(lines.at(-1)).not.toContain("d delete")
  })

  test("c turns focus on first, and esc keeps the unsaved text for the next compose", () => {
    const comments = new TurnComments()
    const reader = open(["one\n\ntwo"], comments)
    reader.toggleFocus()
    expect(reader.focused()).toBe(false)
    reader.comment(editor())
    expect(reader.focused()).toBe(true)
    type(reader, "draft")
    reader.cancelComment()
    expect(reader.composing()).toBe(false)
    expect(comments.size).toBe(0)
    const again = editor()
    reader.comment(again)
    expect(again.getText()).toBe("draft")
  })

  test("editing starts from the saved comment; empty text deletes it; d deletes and c restores", () => {
    const comments = new TurnComments()
    comments.save("0:0", "one", "saved")
    const reader = open(["one\n\ntwo"], comments)
    const e = editor()
    reader.comment(e)
    expect(e.getText()).toBe("saved")
    for (let i = 0; i < 5; i++) reader.composeInput("\x7f")
    reader.composeInput("\r")
    expect(comments.size).toBe(0)
    comments.save("0:0", "one", "back")
    reader.render(60)
    reader.deleteComment()
    expect(comments.size).toBe(0)
    expect(reader.render(60).some((l) => l.includes("back"))).toBe(false)
    const restore = editor()
    reader.comment(restore)
    expect(restore.getText()).toBe("back")
  })

  test("multi-line comments wrap and keep their line breaks", () => {
    const comments = new TurnComments()
    comments.save("0:0", "one", "first line\n" + "word ".repeat(20).trim())
    const lines = open(["one"], comments).render(30).map(strip)
    const rows = lines.filter((l) => l.includes("┃")).map((l) => l.slice(3, -3).trimEnd())
    expect(rows[0]).toBe("┃ comment")
    expect(rows[1]).toBe("┃ first line")
    expect(rows.length).toBeGreaterThan(3)
    expect(lines.every((l) => l.length === 30)).toBe(true)
  })

  test("comments follow their message across the all/last toggle", () => {
    const comments = new TurnComments()
    const reader = open(["a1\n\na2", "b1"], comments)
    reader.comment(editor())
    type(reader, "on b1")
    reader.composeInput("\r")
    expect(comments.get("1:0")?.quote).toBe("b1")
    reader.toggle()
    reader.render(60)
    reader.toggleFocus()
    reader.toggleFocus()
    reader.render(60)
    reader.comment(editor())
    type(reader, "on a1")
    reader.composeInput("\r")
    expect(comments.entries().map(([k, c]) => [k, c.quote])).toEqual([["0:0", "a1"], ["1:0", "b1"]])
    const all = reader.render(60).map(strip)
    expect(all.findIndex((l) => l.includes("on a1"))).toBe(all.findIndex((l) => l.includes("a1")) + 3)
    expect(all.findIndex((l) => l.includes("on b1"))).toBe(all.findIndex((l) => l.includes("│  b1")) + 3)
    reader.toggle()
    const last = reader.render(80).map(strip)
    expect(last[0]).toContain("last of 2 messages · chunk 1/1 · 2 comments")
    expect(last.some((l) => l.includes("on a1"))).toBe(false)
    expect(last.some((l) => l.includes("on b1"))).toBe(true)
  })

  test("the composed chunk stays in view above the editor", () => {
    const paragraphs = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n\n")
    const reader = open([paragraphs], new TurnComments(), 20)
    for (let i = 0; i < 6; i++) reader.move(1)
    reader.render(60)
    reader.comment(editor())
    const lines = reader.render(60).map(strip)
    expect(lines).toHaveLength(15)
    const at = lines.findIndex((l) => l.includes("line 7"))
    const editorTop = lines.findIndex((l, i) => i > 0 && l.includes("────"))
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(editorTop)
  })

  const codes: Record<string, number> = { accent: 31, border: 34, muted: 90, borderMuted: 37, dim: 35 }
  const colored = { fg: (c: string, s: string) => `\x1b[${codes[c] ?? 36}m${s}\x1b[39m`, bold: (s: string) => s }
  const BORDER = "\x1b[34m"
  const MUTED = "\x1b[90m"
  const END = "\x1b[39m"
  const inner = (l: string) => l.slice(`\x1b[37m│${END}  `.length).replace(/ *\x1b\[37m│\x1b\[39m$/, "")

  test("the comment is set off by a blank line, a label and a border-colored gutter, its text muted", () => {
    const comments = new TurnComments()
    comments.save("0:0", "one", "note")
    const reader = new TurnReader(colored, md, ["one\n\ntwo"], () => 40, false, false, comments)
    reader.toggleFocus()
    expect(reader.render(60).slice(2, 8).map(inner)).toEqual([
      "one",
      "",
      `${BORDER}┃ ${END}${BORDER}comment${END}`,
      `${BORDER}┃ ${END}${MUTED}note${END}`,
      "",
      "two",
    ])
  })

  test("focus dimming keeps the comment label and gutter visible and dims the text", () => {
    const comments = new TurnComments()
    comments.save("0:0", "one", "note")
    const reader = new TurnReader(colored, md, ["one\n\ntwo"], () => 40, false, false, comments)
    reader.render(60)
    reader.move(1)
    const body = reader.render(60).slice(2, 8).map(inner)
    expect(body[0]).toStartWith("\x1b[2m")
    expect(body[2]).toBe(`${BORDER}┃ ${END}${BORDER}comment${END}`)
    expect(body[3]).toStartWith(`${BORDER}┃ ${END}\x1b[2m${MUTED}\x1b[2mnote`)
    expect(body[5]).toBe("two")
  })

  test("comment text stays plain: no markdown, no escape sequences or control characters", () => {
    const comments = new TurnComments()
    comments.save("0:0", "one", "**bold** `code`\n# not a heading\n\x1b[31mred\x1b[0m\ttab\x07")
    const lines = open(["one"], comments).render(60).map(strip)
    const rows = lines.filter((l) => l.includes("┃")).map((l) => l.slice(3, -3).trimEnd())
    expect(rows).toEqual(["┃ comment", "┃ **bold** `code`", "┃ # not a heading", "┃ red  tab"])
  })

  test("narrow widths keep the gutter on every comment row and the frame intact", () => {
    const comments = new TurnComments()
    comments.save("0:0", "one", "a comment with several words and averyveryverylongunbrokenword")
    for (const width of [16, 10, 8]) {
      const lines = new TurnReader(plain, md, ["one"], () => 200, false, false, comments).render(width).map(strip)
      expect(lines.every((l) => l.length === width)).toBe(true)
      const rows = lines.slice(1, -1).map((l) => l.slice(3, -3))
      const at = rows.findIndex((l) => l.startsWith("┃"))
      const gutter = rows.slice(at).filter((l) => l.trim() !== "")
      expect(gutter.length).toBeGreaterThan(2)
      expect(gutter.every((l) => l.startsWith(width > 10 ? "┃ " : "┃"))).toBe(true)
      expect(rows.slice(at + 1).join("").replace(/[┃ ]/g, "")).toBe(
        "acommentwithseveralwordsandaveryveryverylongunbrokenword",
      )
    }
  })

  test("a comment taller than the viewport scrolls with its chunk, label first", () => {
    const comments = new TurnComments()
    comments.save("0:1", "two", Array.from({ length: 30 }, (_, i) => `note ${i + 1}`).join("\n"))
    const reader = open(["one\n\ntwo\n\nthree"], comments, 20)
    reader.move(1)
    const lines = reader.render(60).map(strip)
    expect(lines).toHaveLength(15)
    expect(lines[2]).toContain("two")
    expect(lines[4]).toContain("┃ comment")
    reader.move(1)
    const next = reader.render(60).map(strip)
    expect(next.some((l) => l.includes("three"))).toBe(true)
    expect(next.some((l) => l.includes("note 30"))).toBe(true)
  })

  test("the footer drops low priority hints to fit", () => {
    const comments = new TurnComments()
    comments.save("1:0", "b", "x")
    const paragraphs = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n\n")
    const reader = new TurnReader(plain, md, ["a", paragraphs], () => 16, false, true, comments)
    const wide = reader.render(86).at(-1)!
    expect(wide).toContain("r reply")
    expect(wide).toContain("c comment")
    const narrow = reader.render(50).at(-1)!
    expect(narrow).toHaveLength(50)
    expect(narrow).toContain(" f unfocus · c comment · d delete · r reply ")
    expect(narrow).not.toContain("s speak")
  })
})

describe("TurnReader speech", () => {
  test("outside focus mode speaks the displayed messages", () => {
    const reader = new TurnReader(plain, md, ["first", "one\n\ntwo"], () => 40, false, true)
    reader.render(60)
    reader.toggleFocus()
    expect(reader.spoken()).toEqual(["one\n\ntwo"])
    reader.toggle()
    expect(reader.spoken()).toEqual(["first", "one\n\ntwo"])
  })

  test("in focus mode speaks only the focused chunk, following navigation", () => {
    const reader = new TurnReader(plain, md, ["# Title\nintro\n\nsecond\n\nthird"], () => 40, false, true)
    reader.render(60)
    expect(reader.spoken()).toEqual(["# Title\nintro"])
    reader.move(1)
    expect(reader.spoken()).toEqual(["second"])
    reader.move(1)
    expect(reader.spoken()).toEqual(["third"])
    reader.toggleFocus()
    expect(reader.spoken()).toEqual(["# Title\nintro\n\nsecond\n\nthird"])
  })

  test("a focused chunk is spoken without its comment, a list continuation dedented", () => {
    const comments = new TurnComments()
    comments.save("0:1", "  more", "my note")
    const reader = new TurnReader(plain, md, ["- item\n\n  more"], () => 40, false, true, comments)
    reader.render(60)
    reader.move(1)
    expect(reader.render(60).some((l) => l.includes("my note"))).toBe(true)
    expect(reader.spoken()).toEqual(["more"])
  })

  test("after toggling messages in focus mode speaks a chunk of the new view before a render", () => {
    const reader = new TurnReader(plain, md, ["first\n\nalpha", "second"], () => 40, false, true)
    reader.render(60)
    reader.toggle()
    expect(reader.spoken()).toEqual(["first"])
  })

  test("hints that s speaks the chunk while focused", () => {
    const reader = new TurnReader(plain, md, ["one\n\ntwo"], () => 40, false, true)
    expect(reader.render(80).at(-1)).toContain("s speak chunk · f unfocus")
    reader.toggleFocus()
    expect(reader.render(80).at(-1)).toContain("s speak · f focus")
    expect(reader.render(80).at(-1)).not.toContain("s speak chunk")
  })
})

describe("TurnReader copy", () => {
  test("only focus mode has a source to copy: the focused chunk, following navigation", () => {
    const reader = new TurnReader(plain, md, ["# Title\nintro\n\nsecond"], () => 40)
    expect(reader.focusedSource()).toBeUndefined()
    reader.render(60)
    expect(reader.focusedSource()).toBe("# Title\nintro")
    reader.move(1)
    expect(reader.focusedSource()).toBe("second")
    reader.toggleFocus()
    expect(reader.focusedSource()).toBeUndefined()
  })

  test("the copied source keeps its markdown and leaves out the chunk's comment", () => {
    const comments = new TurnComments()
    comments.save("0:0", "**bold** `code`", "my note")
    const reader = new TurnReader(plain, md, ["**bold** `code`"], () => 40, false, false, comments)
    expect(reader.render(60).some((l) => l.includes("my note"))).toBe(true)
    expect(reader.focusedSource()).toBe("**bold** `code`")
  })

  test("a flash replaces the hints until cleared, fits narrow widths and yields to the composer", () => {
    const reader = new TurnReader(plain, md, ["one\n\ntwo"], () => 40)
    reader.render(80)
    reader.showFlash("copied")
    expect(reader.render(80).at(-1)).toContain(" copied ")
    expect(reader.render(80).at(-1)).not.toContain("f unfocus")
    reader.showFlash("copy failed: " + "x".repeat(100))
    const narrow = reader.render(30).at(-1)!
    expect(visibleWidth(narrow)).toBe(30)
    expect(narrow).toContain("copy failed")
    reader.comment(new Editor({ terminal: { rows: 40 }, requestRender: () => {} } as never, { borderColor: id, selectList: {} as never }))
    expect(reader.render(80).at(-1)).toContain("enter save")
    reader.cancelComment()
    expect(reader.render(80).at(-1)).toContain("copy failed")
    reader.clearFlash()
    expect(reader.render(80).at(-1)).toContain(`f unfocus · ${COPY_KEY} copy`)
  })

  test("hints the copy key only while focused, dropping it first when narrow", () => {
    const reader = new TurnReader(plain, md, ["one\n\ntwo"], () => 40)
    expect(reader.render(80).at(-1)).toContain(`f unfocus · ${COPY_KEY} copy · c comment`)
    expect(reader.render(40).at(-1)).not.toContain(`${COPY_KEY} copy`)
    reader.toggleFocus()
    expect(reader.render(80).at(-1)).not.toContain(`${COPY_KEY} copy`)
  })
})
