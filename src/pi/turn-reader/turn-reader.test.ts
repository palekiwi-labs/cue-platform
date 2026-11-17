import { describe, expect, test } from "bun:test"
import type { MarkdownTheme } from "@earendil-works/pi-tui"
import { latestTurnTexts } from "./latest-turn"
import { faint, FOCUS_KEY, MODE_KEY, readerHeight, readerWidth, TEXT_WIDTH, TurnReader } from "./reader"

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
    const lines = reader.render(40)
    expect(lines[0]).toStartWith("╭─ latest turn · last of 2 messages ")
    expect(lines.slice(1, -1).map((l) => l.slice(1, -1).trim())).toEqual(["", "second", ""])
    expect(lines.at(-1)).toContain(`${MODE_KEY} all · ${FOCUS_KEY} focus · esc close`)
    expect(reader.shown()).toEqual(["second"])
    expect(lines.every((l) => l.length === 40)).toBe(true)
  })

  test("toggles to all messages as markdown, separated by a rule, and back", () => {
    const reader = new TurnReader(plain, md, ["# Title\n\nbody", "second"], () => 40)
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
    expect(new TurnReader(plain, md, ["text"], () => 40, false, true).render(40).at(-1)).toContain("s speak · f focus · esc close")
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

  test("starts off with nothing dimmed", () => {
    const reader = new TurnReader(plain, md, ["one\n\ntwo"], () => 40)
    const lines = reader.render(60)
    expect(reader.focused()).toBe(false)
    expect(lines.some(isFaint)).toBe(false)
    expect(lines[0]).not.toContain("chunk")
    expect(lines.at(-1)).toContain(`${FOCUS_KEY} focus · esc close`)
  })

  test("f focuses the first chunk and dims the others, f again clears it", () => {
    const reader = new TurnReader(plain, md, ["# Title\nintro\n\nsecond\n\nthird"], () => 40)
    reader.render(60)
    reader.toggleFocus()
    const lines = reader.render(60)
    expect(lines[0]).toContain("latest turn · 1 message · chunk 1/3")
    expect(focusedText(lines)).toEqual(["Title", "intro"])
    expect(body(lines).filter(isFaint).map(text)).toEqual(["second", "third"])
    expect(lines.at(-1)).toContain(`${FOCUS_KEY} unfocus · ↑↓ chunk · esc`)
    reader.toggleFocus()
    expect(reader.render(60).some(isFaint)).toBe(false)
  })

  test("a wrapped chunk is focused on every line", () => {
    const long = "word ".repeat(30).trim()
    const reader = new TurnReader(plain, md, [`${long}\n\nafter`], () => 40)
    reader.render(26)
    reader.toggleFocus()
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
    reader.toggleFocus()
    for (let i = 0; i < 5; i++) reader.move(1)
    expect(view()[0]).toContain("chunk 6/30")
    expect(focusedText(view())).toEqual(["line 6"])
    expect(text(body(view()).at(-1)!)).toBe("line 6")
    expect(view().at(-1)).toContain("4-11/59")
    for (let i = 0; i < 4; i++) reader.move(-1)
    expect(text(body(view())[0]!)).toBe("line 2")
    for (let i = 0; i < 5; i++) reader.move(-1)
    expect(view()[0]).toContain("chunk 1/30")
    expect(view().at(-1)).toContain("1-8/59")
    for (let i = 0; i < 40; i++) reader.move(1)
    expect(view()[0]).toContain("chunk 30/30")
    expect(view().at(-1)).toContain("52-59/59")
  })

  test("outside focus mode the arrows scroll by line", () => {
    const reader = new TurnReader(plain, md, [paragraphs(30)], () => 16)
    reader.render(60)
    reader.move(1)
    reader.move(1)
    expect(reader.render(60).at(-1)).toContain("3-10/59")
  })

  test("manual scrolling holds until the next chunk step", () => {
    const reader = new TurnReader(plain, md, [paragraphs(30)], () => 16)
    reader.render(60)
    reader.toggleFocus()
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
    reader.toggleFocus()
    reader.move(1)
    const lines = reader.render(60)
    expect(text(body(lines)[0]!)).toBe("```")
    expect(body(lines).some(isFaint)).toBe(false)
  })

  test("a fenced block with blank lines is a single chunk", () => {
    const reader = new TurnReader(plain, md, ["```\na\n\nb\n```\n\nafter"], () => 40)
    reader.render(60)
    reader.toggleFocus()
    const lines = reader.render(60)
    expect(lines[0]).toContain("chunk 1/2")
    expect(focusedText(lines)).toEqual(["```", "a", "b", "```"])
  })

  test("list numbering and continuation indent survive chunking", () => {
    const reader = new TurnReader(plain, md, ["1. Step\n\n   More\n\n2. Next"], () => 40)
    const rows = body(reader.render(60)).map((l) => l.slice(3, -3).trimEnd())
    expect(rows).toEqual(["1. Step", "", "   More", "", "2. Next"])
  })

  test("chunks run across messages and the rule is dimmed", () => {
    const reader = new TurnReader(plain, md, ["a1\n\na2", "b1"], () => 40)
    reader.toggle()
    reader.render(60)
    reader.toggleFocus()
    reader.move(1)
    reader.move(1)
    const lines = reader.render(60)
    expect(lines[0]).toContain("chunk 3/3")
    expect(focusedText(lines)).toEqual(["b1"])
    expect(body(lines).filter(isFaint).map(text)).toEqual(["a1", "a2", "---"])
    reader.toggle()
    expect(reader.render(60)[0]).toContain("chunk 1/1")
  })
})
