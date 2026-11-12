import { describe, expect, test } from "bun:test"
import { speakableText } from "./speakable-text"

describe("speakableText (turn-summary regression)", () => {
  test("strips markdown, code, paths and urls", () => {
    const raw = [
      "## Done",
      "",
      "- I **fixed** the `parser` in src/pi/lib/parse.ts and ./README.md.",
      "- See https://example.com/x for [details](https://example.com).",
      "```ts\nconst x = 1\n```",
      "Tests pass.",
    ].join("\n")
    expect(speakableText(raw)).toBe("Done\n\nI fixed the parser in and See for details.\n\nTests pass.")
  })

  test("keeps paragraph breaks and joins lines inside a paragraph", () => {
    expect(speakableText("I fixed it.\nTests pass.\n\n\n  Want me to merge?  ")).toBe(
      "I fixed it. Tests pass.\n\nWant me to merge?",
    )
  })

  test("drops commit hashes but keeps ordinary words and numbers", () => {
    expect(speakableText("I committed it as becb525335 and a931fe9, 114 specs pass, decaded.")).toBe(
      "I committed it as and, 114 specs pass, decaded.",
    )
  })

  test("leaves plain prose alone", () => {
    const prose = "I updated the parser so empty input no longer crashes, and the tests pass."
    expect(speakableText(prose)).toBe(prose)
  })
})
