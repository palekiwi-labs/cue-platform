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

describe("speakableText fixtures", () => {
  test("keeps slashes between words in prose", () => {
    const prose = "It reads input and/or output from the input/output layer."
    expect(speakableText(prose)).toBe(prose)
  })

  test("still drops paths", () => {
    expect(speakableText("Edit src/pi/lib/a.ts and lib/b.ts in ~/cue or ../x, not /etc/hosts.")).toBe(
      "Edit and in or, not",
    )
  })

  test("keeps short inline identifiers and drops longer inline code", () => {
    expect(speakableText("Run `cue list --context foo` so `parser` and `foo.ts` call `load()`.")).toBe(
      "Run so parser and foo.ts call load.",
    )
  })

  test("leaves no empty brackets or stray commas where code was dropped", () => {
    expect(speakableText("It reads (`cue context list --json`) and ranks (`a b`, `c d`, keys).")).toBe(
      "It reads and ranks (keys).",
    )
  })

  test("drops a fenced block that is never closed", () => {
    expect(speakableText("Here it is:\n\n```ts\nconst x = 1\n\nconst y = 2")).toBe("Here it is:")
  })

  test("drops tilde fences and longer backtick fences", () => {
    const raw = "Before.\n~~~\ncode\n~~~\nMiddle.\n````md\n```\ninner\n```\n````\nAfter."
    expect(speakableText(raw)).toBe("Before.\n\nMiddle.\n\nAfter.")
  })

  test("drops table rows", () => {
    const raw = "Results:\n| name | count |\n|------|------:|\n| a | 1 |\nDone."
    expect(speakableText(raw)).toBe("Results:\n\nDone.")
  })
})
