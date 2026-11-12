import { cleanParagraph, dropCodeAndTables } from "../lib/speakable-text"

/** Fragments shorter than this are merged with a neighbour. */
export const MIN_SENTENCE = 40
/** Longer sentences are cut, preferably after a comma, otherwise at a space. */
export const MAX_SENTENCE = 400

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/
const HEADING = /^\s{0,3}#{1,6}\s/
const SENTENCE_END = /(?<=[.!?]+["')\]]*)\s+/

function blocks(text: string): string[] {
  const out: string[] = []
  let current: string[] = []
  const end = () => {
    if (current.length > 0) out.push(current.join("\n"))
    current = []
  }
  for (const line of dropCodeAndTables(text).split("\n")) {
    if (line.trim() === "") {
      end()
    } else if (HEADING.test(line)) {
      end()
      current.push(line)
      end()
    } else {
      if (LIST_ITEM.test(line)) end()
      current.push(line)
    }
  }
  end()
  return out
}

function forceCut(sentence: string, max: number): string[] {
  const out: string[] = []
  let rest = sentence
  while (rest.length > max) {
    const window = rest.slice(0, max + 1)
    let cut = window.lastIndexOf(", ") + 1
    if (cut < max / 2) cut = window.lastIndexOf(" ")
    if (cut <= 0) cut = max
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest !== "") out.push(rest)
  return out
}

function mergeShort(fragments: string[], min: number, max: number): string[] {
  const out: string[] = []
  for (const fragment of fragments) {
    const last = out[out.length - 1]
    if (last !== undefined && last.length < min && last.length + 1 + fragment.length <= max) {
      out[out.length - 1] = `${last} ${fragment}`
    } else {
      out.push(fragment)
    }
  }
  const tail = out[out.length - 1]
  const before = out[out.length - 2]
  if (tail !== undefined && before !== undefined && tail.length < min && before.length + 1 + tail.length <= max) {
    out.splice(-2, 2, `${before} ${tail}`)
  }
  return out
}

/**
 * Split a whole assistant message into speakable sentences: code, tables,
 * markdown, paths and URLs are removed; blocks, list items and sentence
 * ends are cut points; short fragments are merged and long ones cut.
 */
export function splitSentences(text: string, min = MIN_SENTENCE, max = MAX_SENTENCE): string[] {
  const fragments = blocks(text).flatMap((block) => {
    const clean = cleanParagraph(block)
    if (clean === "") return []
    const closed = /[.!?:;,]["')\]]*$/.test(clean) ? clean : `${clean}.`
    return closed.split(SENTENCE_END).flatMap((s) => forceCut(s.trim(), max))
  })
  return mergeShort(
    fragments.filter((s) => s !== ""),
    min,
    max,
  )
}
