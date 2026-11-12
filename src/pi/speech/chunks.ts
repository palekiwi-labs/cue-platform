/** A chunk is cut at the first cut point that gives at least this many characters. */
export const MIN_CHUNK = 40
/** No chunk is longer than this many UTF-16 code units. */
export const MAX_CHUNK = 400

const CUT_POINT = /\n|[.!?]+["'`)\]*_]*(?=\s)/g
const LEADING_SPACE = /^\s+/
const LAST_SPACE = /\s(?=\S*$)/

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/**
 * Cuts streamed text into chunks for transport without changing it. Every
 * chunk is a contiguous slice of the input with the whitespace at its cut
 * points trimmed; nothing else is removed and nothing is added. Cut points
 * are line ends and sentence ends followed by whitespace. Text longer than
 * the maximum without a cut point is cut at its last whitespace, or hard
 * when it has none.
 */
export class Chunker {
  private pending = ""

  constructor(
    private readonly min = MIN_CHUNK,
    private readonly max = MAX_CHUNK,
  ) {}

  /** Add text and return the chunks it completed. */
  push(text: string): string[] {
    this.pending += text
    const out: string[] = []
    for (;;) {
      this.pending = this.pending.replace(LEADING_SPACE, "")
      const cut = this.nextCut()
      if (cut === null) return out
      const chunk = this.pending.slice(0, cut).trimEnd()
      if (chunk !== "") out.push(chunk)
      this.pending = this.pending.slice(cut)
    }
  }

  /** Return every chunk still held, including a short tail, and reset. */
  flush(): string[] {
    const out = this.push("")
    const tail = this.pending.trim()
    this.pending = ""
    if (tail !== "") out.push(tail)
    return out
  }

  private nextCut(): number | null {
    let lastFitting = 0
    for (const match of this.pending.matchAll(CUT_POINT)) {
      const end = match.index + match[0].length
      if (end > this.max) break
      if (this.pending.slice(0, end).trimEnd().length >= this.min) return end
      lastFitting = end
    }
    if (this.pending.length <= this.max) return null
    if (lastFitting > 0) return lastFitting
    const space = this.pending.slice(0, this.max + 1).search(LAST_SPACE)
    if (space > 0) return space
    return isHighSurrogate(this.pending.charCodeAt(this.max - 1)) ? this.max - 1 : this.max
  }
}

/** Cut a whole text into chunks, as a Chunker fed all of it at once. */
export function splitChunks(text: string, min = MIN_CHUNK, max = MAX_CHUNK): string[] {
  const chunker = new Chunker(min, max)
  return [...chunker.push(text), ...chunker.flush()]
}
