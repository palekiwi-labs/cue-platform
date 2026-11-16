import { classifyLine, opensBlock, sentenceMayEnd, START, type BlockState, type LineInfo } from "./markdown"

/** A chunk is cut at the first cut point that gives at least this many characters. */
export const MIN_CHUNK = 40
/** No chunk is longer than this many UTF-16 code units. */
export const MAX_CHUNK = 400

const SENTENCE_END = /[.!?\u2026]+["'`)\]*_]*/g
const CLAUSE_END = /[,;:\u2013\u2014]/
const SPACE = /\s/
const LOWERCASE = /\p{Ll}/u
const LAST_SPACE = /\s(?=\S*$)/
const BLOCK_END = new Set(["blank", "code", "fence", "heading", "underline", "rule", "table"])

type Decision = boolean | undefined

interface Line {
  start: number
  end: number
  info: LineInfo
  after: BlockState
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function combine(a: Decision, b: Decision): Decision {
  if (a === true || b === true) return true
  if (a === undefined || b === undefined) return undefined
  return false
}

/**
 * Cuts streamed Markdown into chunks for transport without changing it.
 * Every chunk is a contiguous slice of the input with the whitespace at
 * its cut points trimmed; nothing else is removed and nothing is added.
 *
 * Cut points are paragraph breaks, the ends of block lines (headings,
 * table rows, rules, fences and code lines), line ends before a line
 * that opens a block (heading, list item, fence, table row, quote), and
 * sentence ends followed by whitespace and then anything but a lowercase
 * letter. Any other line end is a soft wrap: plain whitespace. Text
 * longer than the maximum without a cut point is cut after its last
 * clause mark, else at its last whitespace, else hard.
 *
 * A cut point that depends on text not received yet is held until that
 * text arrives (at most the next line's indentation and block marker, or
 * the whitespace after a sentence end), so any split of the stream gives
 * the same chunks as the whole text.
 */
export class Chunker {
  protected text = ""
  protected readonly lines: Line[] = []
  protected final = false
  private pos = 0

  constructor(
    private readonly min = MIN_CHUNK,
    private readonly max = MAX_CHUNK,
  ) {}

  /** Add text and return the chunks it completed. */
  push(text: string): string[] {
    this.text += text
    this.scanLines()
    return this.drain()
  }

  /** Return every chunk still held, including a short tail, and reset. */
  flush(): string[] {
    this.final = true
    const out = this.drain()
    this.skipSpace()
    const tail = this.text.slice(this.pos).trimEnd()
    if (tail !== "") {
      const chunk = this.render(this.pos, this.pos + tail.length)
      if (chunk !== "") out.push(chunk)
    }
    this.text = ""
    this.lines.length = 0
    this.final = false
    this.pos = 0
    return out
  }

  /** The chunk text for the slice from start to end. */
  protected render(start: number, end: number): string {
    return this.text.slice(start, end)
  }

  /** Index of the line holding position `at`; lines.length for the unfinished last line. */
  protected lineAt(at: number): number {
    let low = 0
    let high = this.lines.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (this.lines[mid]!.end < at) low = mid + 1
      else high = mid
    }
    return low
  }

  protected lineStart(index: number): number {
    if (index < this.lines.length) return this.lines[index]!.start
    const last = this.lines[this.lines.length - 1]
    return last ? last.end + 1 : 0
  }

  protected stateBefore(index: number): BlockState {
    return index > 0 ? this.lines[index - 1]!.after : START
  }

  protected lineInfo(index: number): LineInfo {
    const line = this.lines[index]
    if (line) return line.info
    return classifyLine(this.stateBefore(index), this.text.slice(this.lineStart(index))).info
  }

  private scanLines(): void {
    let start = this.lineStart(this.lines.length)
    for (;;) {
      const end = this.text.indexOf("\n", start)
      if (end < 0) return
      const { info, next } = classifyLine(this.stateBefore(this.lines.length), this.text.slice(start, end))
      this.lines.push({ start, end, info, after: next })
      start = end + 1
    }
  }

  private skipSpace(): void {
    while (this.pos < this.text.length && SPACE.test(this.text[this.pos]!)) this.pos++
  }

  private drain(): string[] {
    const out: string[] = []
    for (;;) {
      this.skipSpace()
      const cut = this.nextCut()
      if (cut === null) return out
      const end = this.pos + this.text.slice(this.pos, cut).trimEnd().length
      if (end > this.pos) {
        const chunk = this.render(this.pos, end)
        if (chunk !== "") out.push(chunk)
      }
      this.pos = cut
    }
  }

  private nextCut(): number | null {
    const start = this.pos
    let fitting = -1
    for (const [at, decision] of this.candidates(start, start + this.max)) {
      if (decision === undefined) return null
      if (!decision) continue
      if (this.text.slice(start, at).trimEnd().length >= this.min) return at
      fitting = at
    }
    if (this.text.length - start <= this.max) return null
    if (fitting > start) return fitting
    return this.fallback(start)
  }

  private candidates(start: number, limit: number): [number, Decision][] {
    const found = new Map<number, Decision>()
    const add = (at: number, decision: Decision) =>
      found.set(at, found.has(at) ? combine(found.get(at), decision) : decision)
    for (let n = this.text.indexOf("\n", start); n >= 0 && n <= limit; n = this.text.indexOf("\n", n + 1)) {
      add(n, this.newlineCut(n))
    }
    SENTENCE_END.lastIndex = start
    for (let m = SENTENCE_END.exec(this.text); m; m = SENTENCE_END.exec(this.text)) {
      const end = m.index + m[0].length
      if (end > limit) break
      add(end, this.sentenceCut(m.index, end, m[0]))
    }
    return [...found].sort((a, b) => a[0] - b[0])
  }

  private newlineCut(at: number): Decision {
    const line = this.lines[this.lineAt(at)]!
    if (BLOCK_END.has(line.info.kind)) return true
    const next = this.text.indexOf("\n", at + 1)
    const prefix = this.text.slice(at + 1, next < 0 ? undefined : next)
    return opensBlock(line.after, prefix, next >= 0 || this.final)
  }

  private sentenceCut(start: number, end: number, token: string): Decision {
    if (end >= this.text.length) return this.final ? true : undefined
    if (!SPACE.test(this.text[end]!)) return false
    const index = this.lineAt(start)
    if (!sentenceMayEnd(this.stateBefore(index), this.text.slice(this.lineStart(index), start), token)) return false
    let at = end
    while (at < this.text.length && SPACE.test(this.text[at]!)) at++
    if (at >= this.text.length) return this.final ? true : undefined
    return !LOWERCASE.test(this.text[at]!)
  }

  private fallback(start: number): number {
    const window = this.text.slice(start, start + this.max + 1)
    for (let i = window.length - 2; i >= this.min; i--) {
      if (CLAUSE_END.test(window[i]!) && SPACE.test(window[i + 1]!)) return start + i + 1
    }
    const space = window.search(LAST_SPACE)
    if (space > 0) return start + space
    return start + (isHighSurrogate(this.text.charCodeAt(start + this.max - 1)) ? this.max - 1 : this.max)
  }
}

/** Cut a whole text into chunks, as a Chunker fed all of it at once. */
export function splitChunks(text: string, min = MIN_CHUNK, max = MAX_CHUNK): string[] {
  const chunker = new Chunker(min, max)
  return [...chunker.push(text), ...chunker.flush()]
}
