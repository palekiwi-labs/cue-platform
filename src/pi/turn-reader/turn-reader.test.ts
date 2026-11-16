import { describe, expect, test } from "bun:test"
import type { MarkdownTheme } from "@earendil-works/pi-tui"
import { latestTurnTexts } from "./latest-turn"
import { readerWidth, TEXT_WIDTH, TurnReader } from "./reader"

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

  test("renders messages as markdown, separated by a rule, sized to content", () => {
    const reader = new TurnReader(plain, md, ["# Title\n\nbody", "second"], () => 40)
    const lines = reader.render(30)
    expect(lines[0]).toStartWith("╭─ latest turn · 2 messages ")
    expect(lines.slice(1, -1).map((l) => l.slice(1, -1).trim())).toEqual([
      "", "Title", "", "body", "", "┄".repeat(24), "", "second", "",
    ])
    expect(lines.at(-1)).toContain("esc close")
    expect(lines.every((l) => l.length === 30)).toBe(true)
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
    expect(reader.viewport()).toBe(10)
    expect(view()).toHaveLength(14)
    expect(view()[0]).toContain("snapshot")
    expect(view()[2]).toContain("line 1")
    expect(view().at(-1)).toContain("1-10/59")
    reader.scroll(2)
    expect(view()[2]).toContain("line 2")
    reader.page(1)
    expect(view().at(-1)).toContain("12-21/59")
    reader.bottom()
    expect(view()[11]).toContain("line 30")
    expect(view().at(-1)).toContain("50-59/59")
    reader.scroll(5)
    expect(view().at(-1)).toContain("50-59/59")
    reader.top()
    reader.scroll(-3)
    expect(view().at(-1)).toContain("1-10/59")
  })
})
