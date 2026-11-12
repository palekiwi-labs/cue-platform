import { describe, expect, test } from "bun:test"
import { Chunker, MAX_CHUNK, MIN_CHUNK, splitChunks } from "./chunks"

function expectLossless(text: string, chunks: string[], max = MAX_CHUNK): void {
  let at = 0
  for (const chunk of chunks) {
    expect(chunk).not.toBe("")
    expect(chunk).toBe(chunk.trim())
    expect(chunk.length).toBeLessThanOrEqual(max)
    while (at < text.length && /\s/.test(text[at]!)) at++
    expect(text.slice(at, at + chunk.length)).toBe(chunk)
    at += chunk.length
  }
  expect(text.slice(at).trim()).toBe("")
}

function streamed(text: string, cuts: number[], min = MIN_CHUNK, max = MAX_CHUNK): string[] {
  const chunker = new Chunker(min, max)
  const out: string[] = []
  let from = 0
  for (const cut of [...cuts, text.length]) {
    out.push(...chunker.push(text.slice(from, cut)))
    from = cut
  }
  return [...out, ...chunker.flush()]
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

const long = (s: string, end = ".") => `${s} and this clause pads it past forty characters${end}`

const MARKDOWN = [
  "## Summary of the change",
  "",
  "I updated `src/pi/speech/index.ts` and ~/notes/a.md, see https://example.com/a/b?c=1&d=2#x for details.",
  "The ratio is 1.5 now (it was 2.0), and/or the e.g. case still works!",
  "",
  "- **first** item with [a link](https://example.com/docs/page.html)",
  "- second item: `const x = a?.b ?? c;`",
  "",
  "| name | count |",
  "|------|------:|",
  "| a    | 1     |",
  "",
  "```ts",
  "export function f(a: number): number {",
  "  return a * 2. + 1",
  "}",
  "```",
  "",
  "~~~",
  "tilde fence. never closed",
].join("\n")

describe("splitChunks", () => {
  test("cuts at sentence ends followed by whitespace", () => {
    const a = long("The first sentence is here")
    const b = long("Is the second one a question", "?")
    const c = long("The third one shouts", "!")
    expect(splitChunks(`${a} ${b}\n${c}`)).toEqual([a, b, c])
  })

  test("does not cut inside file names or decimal numbers", () => {
    const text = "I changed foo.ts so the ratio is 1.5 now, which matches the old value. Done with that part of the change as well."
    expect(splitChunks(text)).toEqual([
      "I changed foo.ts so the ratio is 1.5 now, which matches the old value.",
      "Done with that part of the change as well.",
    ])
  })

  test("adds no punctuation to unterminated text, list items or headings", () => {
    const text = [
      "## A heading without a full stop",
      "",
      "- the tokenizer now accepts an empty input string",
      "- the parser returns an empty tree for that input",
    ].join("\n")
    expect(splitChunks(text)).toEqual([
      "## A heading without a full stop\n\n- the tokenizer now accepts an empty input string",
      "- the parser returns an empty tree for that input",
    ])
  })

  test("keeps short fragments together until a chunk is long enough", () => {
    const text = "## Done\n\nAll good. Tests pass. Want me to merge it into dev now?"
    expect(splitChunks(text)).toEqual([text])
  })

  test("keeps code, markdown, tables, links, paths and inline code", () => {
    const chunks = splitChunks(MARKDOWN)
    expectLossless(MARKDOWN, chunks)
    const joined = chunks.join("\n")
    for (const kept of [
      "`src/pi/speech/index.ts`",
      "~/notes/a.md",
      "https://example.com/a/b?c=1&d=2#x",
      "[a link](https://example.com/docs/page.html)",
      "**first**",
      "| name | count |",
      "|------|------:|",
      "```ts",
      "export function f(a: number): number {",
      "~~~",
      "tilde fence. never closed",
    ]) {
      expect(joined).toContain(kept)
    }
  })

  test("is lossless for whitespace-heavy text", () => {
    const text = "  \n\nfirst line\n\n\n   indented second line that is long enough to stand alone.\t \n  \n"
    expectLossless(text, splitChunks(text))
  })

  test("cuts long text at the last whitespace within the limit", () => {
    const clause = "word ".repeat(30).trim()
    const text = Array.from({ length: 5 }, () => clause).join(", ") + "."
    const parts = splitChunks(text)
    expect(parts.length).toBeGreaterThan(1)
    expectLossless(text, parts)
    const spaced = "word ".repeat(200).trim()
    const pieces = splitChunks(spaced)
    expectLossless(spaced, pieces)
    expect(pieces.at(-1)!.endsWith(".")).toBe(false)
  })

  test("hard-cuts unbroken strings without splitting surrogate pairs", () => {
    const unbroken = "x".repeat(MAX_CHUNK * 2 + 17)
    const parts = splitChunks(unbroken)
    expect(parts.map((p) => p.length)).toEqual([MAX_CHUNK, MAX_CHUNK, 17])
    expectLossless(unbroken, parts)
    const emoji = "a" + "\u{1F600}".repeat(MAX_CHUNK)
    const pieces = splitChunks(emoji)
    expectLossless(emoji, pieces)
    for (const p of pieces) expect(LONE_SURROGATE.test(p)).toBe(false)
  })

  test("a short sentence before a long line is cut at its own end", () => {
    const text = `Done.\n${"y".repeat(MAX_CHUNK + 5)}`
    const parts = splitChunks(text)
    expect(parts[0]).toBe("Done.")
    expectLossless(text, parts)
  })

  test("returns nothing for empty or blank text", () => {
    expect(splitChunks("")).toEqual([])
    expect(splitChunks(" \n\t\n")).toEqual([])
  })
})

describe("Chunker", () => {
  const text = [
    long("First sentence of the reply"),
    long("Second sentence asks a question", "?"),
    "Here is `inline code` and a path ./src/a.ts plus https://example.com/x.",
    "",
    "| a | b |",
    "```",
    "code line. still code",
    "```",
    "x".repeat(MAX_CHUNK + 30),
    "Tail without a full stop",
  ].join(" \n")

  test("deltas split at every boundary give the same chunks as the whole text", () => {
    const whole = splitChunks(text)
    expectLossless(text, whole)
    for (let i = 0; i <= text.length; i++) expect(streamed(text, [i])).toEqual(whole)
  })

  test("one character at a time gives the same chunks as the whole text", () => {
    const cuts = Array.from({ length: text.length }, (_, i) => i)
    expect(streamed(text, cuts)).toEqual(splitChunks(text))
  })

  test("emits a chunk as soon as its cut point is seen", () => {
    const chunker = new Chunker()
    const a = long("The first sentence is here")
    expect(chunker.push(a)).toEqual([])
    expect(chunker.push(" The")).toEqual([a])
    expect(chunker.push(" rest")).toEqual([])
    expect(chunker.flush()).toEqual(["The rest"])
    expect(chunker.flush()).toEqual([])
  })

  test("emits long text without a cut point once it passes the limit", () => {
    const chunker = new Chunker()
    expect(chunker.push("z".repeat(MAX_CHUNK))).toEqual([])
    expect(chunker.push("z")).toEqual(["z".repeat(MAX_CHUNK)])
    expect(chunker.flush()).toEqual(["z"])
  })
})
