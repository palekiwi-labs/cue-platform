import { describe, expect, test } from "bun:test"
import { Chunker, MAX_CHUNK, MIN_CHUNK, SpokenChunker, spokenChunks, splitChunks } from "./chunks"

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

function streamed(text: string, cuts: number[], min = MIN_CHUNK, max = MAX_CHUNK, chunker = new Chunker(min, max)): string[] {
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

function wrap(text: string, width: number): string {
  return text
    .split("\n")
    .map((paragraph) => {
      const lines: string[] = []
      let line = ""
      for (const word of paragraph.split(" ")) {
        if (line !== "" && line.length + 1 + word.length > width) {
          lines.push(line)
          line = word
        } else {
          line = line === "" ? word : `${line} ${word}`
        }
      }
      if (line !== "") lines.push(line)
      return lines.join("\n")
    })
    .join("\n")
}

function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

function randomCuts(length: number, random: () => number): number[] {
  const cuts: number[] = []
  for (let at = 1 + Math.floor(random() * 12); at < length; at += 1 + Math.floor(random() * 12)) cuts.push(at)
  return cuts
}

const PROSE = [
  "The Pi chunker treats a literal newline as a place to send the accumulated text, even in the middle of a sentence, and that is the bug we are fixing here.",
  "Each emitted chunk then goes to Kokoro as a separate request, so it can acquire a pause and the falling pitch of a sentence end, e.g. after a comma.",
  "The ratio went from 1.5 to 2.0 in 2024. Then it fell again, etc. and nobody noticed until the operator listened to a whole reply read aloud!",
  "Is it a voice issue? No, it is the way streamed text is cut before it reaches the bridge; clipboard playback never cuts at line ends.",
].join(" ")

const FIXTURE = [
  "## Summary of the change",
  "I consulted Opus. Its diagnosis agrees with your observation: this is almost",
  "certainly **how streaming text is chunked**, not a property of Heart or Bella,",
  "e.g. the clipboard path. The ratio went from 1.5 to 2.0 in the year",
  "2024. Then it fell\u2026 and rose again.",
  "",
  "Steps to follow:",
  "1. First step that is long enough to stand on its own here",
  "1. Second step, wrapped over two lines because it is long",
  "   and continued with an indent that keeps it in the item.",
  "1. Third step",
  "   - a nested bullet with enough words to be a chunk",
  "   - another nested bullet",
  "1. Fourth step back at the outer level of the list.",
  "",
  "> A quote that is wrapped over",
  "> two lines of the source text.",
  "",
  "Setext heading",
  "==============",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "```sh",
  "# a comment. Not a heading",
  "echo 1. done",
  "```",
  "### Closing hashes ###",
  "Windows line ends follow.\r",
  "They are whitespace too.\r",
  "",
  "~~~",
  "unclosed fence. never closed",
].join("\n")

describe("line ends", () => {
  test("a sentence wrapped over lines is one chunk", () => {
    const text = "This sentence is wrapped by the model at a fixed width,\nso it continues on the next line and ends\nhere. The next sentence is long enough to stand alone."
    expect(splitChunks(text)).toEqual([
      "This sentence is wrapped by the model at a fixed width,\nso it continues on the next line and ends\nhere.",
      "The next sentence is long enough to stand alone.",
    ])
  })

  test("wrapping prose at any width gives the unwrapped chunks", () => {
    const whole = splitChunks(PROSE)
    expect(whole.length).toBeGreaterThan(3)
    for (let width = 20; width <= 100; width++) {
      const wrapped = wrap(PROSE, width)
      expect(splitChunks(wrapped).map((c) => c.replace(/\n/g, " "))).toEqual(whole)
      expect(streamed(wrapped, randomCuts(wrapped.length, seeded(width))).map((c) => c.replace(/\n/g, " "))).toEqual(whole)
    }
  })

  test("a line ending at a sentence end still cuts there", () => {
    const a = long("The first sentence ends at the line end")
    const b = long("The second starts on the next line")
    expect(splitChunks(`${a}\n${b}`)).toEqual([a, b])
  })

  test("paragraph breaks, headings, list items and quotes are cut points", () => {
    const para = long("A paragraph that ends without a full stop", "")
    expect(splitChunks(`${para}\n\n${para}`)).toEqual([para, para])
    expect(splitChunks(`## ${para}\n${para}`)).toEqual([`## ${para}`, para])
    expect(splitChunks(`${para}\n- ${para}\n* ${para}\n+ ${para}`)).toEqual([para, `- ${para}`, `* ${para}`, `+ ${para}`])
    expect(splitChunks(`${para}\n1. ${para}\n1) ${para}\n2) ${para}`)).toEqual([para, `1. ${para}`, `1) ${para}`, `2) ${para}`])
    expect(splitChunks(`${para}\n1. ${para}\n2) ${para}`)).toEqual([para, `1. ${para}\n2) ${para}`])
    expect(splitChunks(`${para}\n> ${para}\n> ${para}`)).toEqual([para, `> ${para}\n> ${para}`])
    expect(splitChunks(`${para}\n| a | b |\n| ${para} |`)).toEqual([para, `| a | b |\n| ${para} |`])
    expect(splitChunks(`${para}\n\`\`\`\n${para}\n\`\`\``)).toEqual([para, `\`\`\`\n${para}`, "```"])
  })

  test("text that only looks like a block start mid-paragraph is a soft wrap", () => {
    const text = [
      "The ratio went from 1.5 in the first quarter to the value in",
      "2024. Then it fell, measured in #hashtags and in",
      "1.5 units, and in -dashes, all on wrapped lines.",
    ].join("\n")
    expect(splitChunks(text)).toEqual([
      "The ratio went from 1.5 in the first quarter to the value in\n2024.",
      "Then it fell, measured in #hashtags and in\n1.5 units, and in -dashes, all on wrapped lines.",
    ])
  })

  test("the number of a list item is never a sentence end", () => {
    const item = "the item text is long enough to be a chunk by itself"
    expect(splitChunks(`Intro line\n1. ${item}\n2. ${item}`)).toEqual([`Intro line\n1. ${item}`, `2. ${item}`])
    expect(splitChunks(`${long("A paragraph")}\n\n10. Ten`)).toEqual([long("A paragraph"), "10. Ten"])
  })

  test("a sentence end before a lowercase word is not a cut", () => {
    const text = "We need a fallback for the long cases, e.g. this one, i.e. the rest, etc. and so on. Done with that part now. Next."
    expect(splitChunks(text)).toEqual([
      "We need a fallback for the long cases, e.g. this one, i.e. the rest, etc. and so on.",
      "Done with that part now. Next.",
    ])
  })

  test("headings, table rows, setext underlines and code lines end their line", () => {
    const text = "Title of it all\n===\nSome text that follows the heading directly and is long. Tail"
    expect(splitChunks(text, 10)).toEqual(["Title of it all\n===", "Some text that follows the heading directly and is long.", "Tail"])
    expect(splitChunks("```\nline one of code\nline two\n```", 5)).toEqual(["```\nline one of code", "line two", "```"])
  })

  test("an over-long sentence falls back to its last clause mark", () => {
    const clause = "word ".repeat(25).trim()
    const text = wrap(`${clause}, ${clause}; ${clause}, ${clause}.`, 72)
    const parts = splitChunks(text)
    expectLossless(text, parts)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts.slice(0, -1)) expect(part).toMatch(/[,;]$/)
  })

  test("CRLF line ends and an ellipsis behave like LF and a full stop", () => {
    const a = long("The first line is wrapped here\r\nand goes on", "\u2026")
    const b = long("The second one starts after the ellipsis")
    expect(splitChunks(`${a} ${b}`)).toEqual([a, b])
  })

  test("the fixture is lossless and keeps its block boundaries", () => {
    const chunks = splitChunks(FIXTURE)
    expectLossless(FIXTURE, chunks)
    expect(chunks).toContain("Then it fell\u2026 and rose again.\n\nSteps to follow:")
    expect(chunks).toContain("1. First step that is long enough to stand on its own here")
    expect(chunks).toContain("1. Second step, wrapped over two lines because it is long\n   and continued with an indent that keeps it in the item.")
    expect(chunks.some((c) => c.endsWith("in the year\n2024."))).toBe(true)
    expect(chunks).toContain("> A quote that is wrapped over\n> two lines of the source text.")
  })
})

describe("streaming lookahead", () => {
  const a = long("A line that is long enough to be its own chunk", "")

  test("a line end waits only for the next line's marker", () => {
    const chunker = new Chunker()
    expect(chunker.push(`${a}\n`)).toEqual([])
    expect(chunker.push("  ")).toEqual([])
    expect(chunker.push("-")).toEqual([])
    expect(chunker.push(" item")).toEqual([a])
    expect(chunker.flush()).toEqual(["- item"])
  })

  test("a soft wrap is settled by the first letter of the next line", () => {
    const chunker = new Chunker()
    expect(chunker.push(`${a}\n`)).toEqual([])
    expect(chunker.push("c")).toEqual([])
    expect(chunker.push("ontinued. Next")).toEqual([`${a}\ncontinued.`])
    expect(chunker.flush()).toEqual(["Next"])
  })

  test("an ordered marker waits for the character after its delimiter", () => {
    const chunker = new Chunker()
    expect(chunker.push(`${a}\n\n`)).toEqual([a])
    expect(chunker.push(`${a}\n1`)).toEqual([])
    expect(chunker.push(".")).toEqual([])
    expect(chunker.push("5 more")).toEqual([])
    expect(chunker.flush()).toEqual([`${a}\n1.5 more`])
  })

  test("a paragraph break is a cut at once", () => {
    const chunker = new Chunker()
    expect(chunker.push(`${a}\n\n`)).toEqual([a])
  })

  test("a sentence end waits for the next non-blank character", () => {
    const chunker = new Chunker()
    const s = long("A full sentence")
    expect(chunker.push(`${s}  `)).toEqual([])
    expect(chunker.push("and")).toEqual([])
    expect(chunker.push(" Then. More")).toEqual([`${s}  and Then.`])
  })

  test("every split of the fixture gives the whole-text chunks", () => {
    const whole = splitChunks(FIXTURE)
    for (let i = 0; i <= FIXTURE.length; i++) expect(streamed(FIXTURE, [i])).toEqual(whole)
    expect(streamed(FIXTURE, Array.from({ length: FIXTURE.length }, (_, i) => i))).toEqual(whole)
    const random = seeded(7)
    for (let run = 0; run < 200; run++) expect(streamed(FIXTURE, randomCuts(FIXTURE.length, random))).toEqual(whole)
  })

  test("small limits keep the stream equal to the whole text", () => {
    for (const [min, max] of [[1, 20], [10, 30], [40, 60]] as const) {
      const whole = splitChunks(FIXTURE, min, max)
      expectLossless(FIXTURE, whole, max)
      for (let i = 0; i <= FIXTURE.length; i += 3) expect(streamed(FIXTURE, [i], min, max)).toEqual(whole)
    }
  })
})

describe("spoken chunks", () => {
  const spoken = (text: string, min = MIN_CHUNK) => spokenChunks(text, min)

  test("drop heading markers that TTS reads as \"number\"", () => {
    expect(spoken("## Recommended fix\n\nChange the chunker so that line ends are soft.")).toEqual([
      "Recommended fix\n\nChange the chunker so that line ends are soft.",
    ])
    expect(spoken("### Closing hashes ###", 1)).toEqual(["Closing hashes"])
    expect(spoken("#", 1)).toEqual([])
    expect(spoken("Title\n=====\n\nBody text.", 1)).toEqual(["Title", "Body text."])
  })

  test("keep # everywhere else", () => {
    for (const text of ["#hashtag is not a heading", "Issue #42 is fixed, C# too", "Text\n#5 on a wrapped line"]) {
      expect(spoken(text)).toEqual([text])
    }
    expect(spoken("```sh\n# a comment\n```")).toEqual(["```sh\n# a comment\n```"])
  })

  test("number ordered items as Markdown renders them", () => {
    const item = "an item long enough to be a chunk of its own"
    expect(spoken(`1. ${item}\n1. ${item}\n1. ${item}`)).toEqual([`1. ${item}`, `2. ${item}`, `3. ${item}`])
    expect(spoken(`3. ${item}\n3. ${item}`)).toEqual([`3. ${item}`, `4. ${item}`])
    expect(spoken("1. a\n1. b\n1. c")).toEqual(["1. a\n2. b\n3. c"])
    expect(spoken("1. a\n\n1. b\n\n   still b\n1. c")).toEqual(["1. a\n\n2. b\n\n   still b\n3. c"])
    expect(spoken("1. a\nlazy line\n1. b")).toEqual(["1. a\nlazy line\n2. b"])
    expect(spoken("1. a\n   1. x\n   1. y\n1. b", 1)).toEqual(["1. a", "1. x", "2. y", "2. b"])
    expect(spoken("1. a\n- x\n1. b", 1)).toEqual(["1. a", "- x", "1. b"])
    expect(spoken("1. a\n1) b")).toEqual(["1. a\n1) b"])
    expect(spoken("1. a\n\nParagraph.\n\n1. b", 1)).toEqual(["1. a", "Paragraph.", "1. b"])
  })

  test("keep decimals, years and numbered plain text as written", () => {
    for (const text of [
      "The ratio is 1.5 now, it was 2.0 before.",
      "1.5 is the ratio at the start of a line.",
      "It happened in the year\n2024. Then it fell.",
      "The list was\n2. not a list here",
      "v1.2.3 and 10.0.0.1 and 3.14",
    ]) {
      expect(spoken(text).join(" ")).toBe(splitChunks(text).join(" "))
    }
    expect(spoken("1. a\n\n2. b\n\n2. c")).toEqual(["1. a\n\n2. b\n\n3. c"])
  })

  test("numbering and headings survive every split of the stream", () => {
    const whole = spokenChunks(FIXTURE)
    expect(whole.join("\n")).toContain("2. Second step")
    expect(whole.join("\n")).toContain("4. Fourth step")
    expect(whole.join("\n")).toContain("Summary of the change")
    expect(whole.join("\n")).not.toContain("## Summary")
    expect(whole.join("\n")).toContain("# a comment. Not a heading")
    expect(whole.join("\n")).not.toContain("==")
    for (let i = 0; i <= FIXTURE.length; i++) {
      expect(streamed(FIXTURE, [i], MIN_CHUNK, MAX_CHUNK, new SpokenChunker())).toEqual(whole)
    }
    const random = seeded(11)
    for (let run = 0; run < 200; run++) {
      expect(streamed(FIXTURE, randomCuts(FIXTURE.length, random), MIN_CHUNK, MAX_CHUNK, new SpokenChunker())).toEqual(whole)
    }
    const cuts = Array.from({ length: FIXTURE.length }, (_, i) => i)
    for (const [min, max] of [[1, 20], [10, 30]] as const) {
      expect(streamed(FIXTURE, cuts, min, max, new SpokenChunker(min, max))).toEqual(spokenChunks(FIXTURE, min, max))
    }
  })
})

describe("random Markdown", () => {
  const TOKENS = [
    "\n", "\n", " ", "  ", "\t", "\r\n", "1.", "1)", "2.", "10.", "#", "## ", "- ", "* ", "+ ", "```", "~~~", "> ",
    "| ", ".", ". ", "! ", "? ", "word", "Word", "and", "e.g.", "1.5", "\u2026", "===", "---", "\u{1F600}", ",", "; ",
  ]

  test("any split of any text gives the whole-text chunks, losslessly", () => {
    const random = seeded(3)
    const pick = (n: number) => Math.floor(random() * n)
    for (let run = 0; run < 400; run++) {
      const text = Array.from({ length: 5 + pick(100) }, () => TOKENS[pick(TOKENS.length)]).join("")
      const min = 1 + pick(50)
      const max = min + 2 + pick(80)
      const whole = splitChunks(text, min, max)
      expectLossless(text, whole, max)
      for (const p of whole) expect(LONE_SURROGATE.test(p)).toBe(false)
      const spoken = spokenChunks(text, min, max)
      for (let k = 0; k < 3; k++) {
        const cuts = randomCuts(text.length, random)
        expect(streamed(text, cuts, min, max)).toEqual(whole)
        expect(streamed(text, cuts, min, max, new SpokenChunker(min, max))).toEqual(spoken)
      }
    }
  })
})
