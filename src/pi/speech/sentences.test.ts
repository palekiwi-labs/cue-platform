import { describe, expect, test } from "bun:test"
import { MAX_SENTENCE, splitSentences } from "./sentences"

const long = (s: string, end = ".") => `${s} and this clause pads it past forty characters${end}`

describe("splitSentences", () => {
  test("cuts at sentence ends followed by whitespace", () => {
    const a = long("The first sentence is here")
    const b = long("Is the second one a question", "?")
    const c = long("The third one shouts", "!")
    expect(splitSentences(`${a} ${b}\n${c}`)).toEqual([a, b, c])
  })

  test("does not cut inside file names or decimal numbers", () => {
    const text = "I changed foo.ts so the ratio is 1.5 now, which matches the old value. Done with that part of the change as well."
    expect(splitSentences(text)).toEqual([
      "I changed foo.ts so the ratio is 1.5 now, which matches the old value.",
      "Done with that part of the change as well.",
    ])
  })

  test("cuts at blank lines and at the end of each list item", () => {
    const text = [
      "Here is what changed in the parser for the empty case",
      "",
      "- the tokenizer now accepts an empty input string",
      "- the parser returns an empty tree for that input",
    ].join("\n")
    expect(splitSentences(text)).toEqual([
      "Here is what changed in the parser for the empty case.",
      "the tokenizer now accepts an empty input string.",
      "the parser returns an empty tree for that input.",
    ])
  })

  test("merges fragments shorter than forty characters", () => {
    expect(splitSentences("## Done\n\nAll good. Tests pass. Want me to merge it into dev now?")).toEqual([
      "Done. All good. Tests pass. Want me to merge it into dev now?",
    ])
  })

  test("merges a short tail into the sentence before it", () => {
    const a = long("This sentence is long enough on its own")
    expect(splitSentences(`${a} Shall I?`)).toEqual([`${a} Shall I?`])
  })

  test("cuts sentences longer than the limit at a comma, else at a space", () => {
    const clause = "word ".repeat(30).trim()
    const text = Array.from({ length: 5 }, () => clause).join(", ") + "."
    const parts = splitSentences(text)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(MAX_SENTENCE)
    expect(parts[0]!.endsWith(",")).toBe(true)
    expect(parts.join(" ")).toBe(text)
    const spaced = "word ".repeat(200).trim()
    const pieces = splitSentences(spaced)
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(MAX_SENTENCE)
    expect(pieces.join(" ")).toBe(`${spaced}.`)
  })

  test("drops fenced code, including unclosed and tilde fences", () => {
    const text = [
      long("Before the code block"),
      "~~~",
      "tilde code. More code.",
      "~~~",
      long("After the code block"),
      "```ts",
      "const x = 1. // never closed",
    ].join("\n")
    expect(splitSentences(text)).toEqual([long("Before the code block"), long("After the code block")])
  })

  test("drops table rows", () => {
    const text = [long("The results are below"), "| name | count |", "|---|---|", "| a | 1 |"].join("\n")
    expect(splitSentences(text)).toEqual([long("The results are below")])
  })

  test("returns nothing for code-only or empty text", () => {
    expect(splitSentences("```\ncode\n```")).toEqual([])
    expect(splitSentences("")).toEqual([])
  })
})
