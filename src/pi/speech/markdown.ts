export type LineKind = "blank" | "code" | "fence" | "heading" | "underline" | "rule" | "table" | "quote" | "item" | "text"

/** What a line is, in the block structure of the text around it. */
export interface LineInfo {
  kind: LineKind
  /** The number an ordered list item is rendered with. */
  number?: number
}

interface OpenList {
  ordered: boolean
  delimiter: string
  content: number
  next: number
}

interface Fence {
  char: string
  length: number
  base: number
}

/** Block state between two lines: open fence, open lists and the kind of the line before. */
export interface BlockState {
  readonly fence: Fence | null
  readonly lists: readonly OpenList[]
  readonly previous: LineKind
}

export const START: BlockState = { fence: null, lists: [], previous: "blank" }

const HEADING = /^#{1,6}(?:[ \t]|$)/
const FENCE_OPEN = /^(?:(`{3,})[^`]*|(~{3,}).*)$/
const FENCE_CLOSE = /^(`{3,}|~{3,})[ \t]*$/
const RULE = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
const UNDERLINE = /^(?:=+|-+)[ \t]*$/
const BULLET = /^([-+*])(?:([ \t]+)(.*)|$)/
const ORDERED = /^(\d{1,9})([.)])(?:([ \t]+)(.*)|$)/
const BLANK = /^[ \t\r]*$/

function indentOf(line: string): { width: number; length: number } {
  let width = 0
  let length = 0
  for (; length < line.length; length++) {
    const c = line[length]
    if (c === " ") width++
    else if (c === "\t") width += 4 - (width % 4)
    else break
  }
  return { width, length }
}

function widthOf(spaces: string, from: number): number {
  let width = from
  for (const c of spaces) width += c === "\t" ? 4 - (width % 4) : 1
  return width - from
}

function containerOf(lists: readonly OpenList[], width: number): number {
  let base = 0
  for (const list of lists) {
    if (list.content > width) break
    base = list.content
  }
  return base
}

function closeTo(lists: readonly OpenList[], width: number): OpenList[] {
  return lists.filter((list) => list.content <= width)
}

interface Item {
  ordered: boolean
  delimiter: string
  start: number
  content: number
  empty: boolean
}

function itemOf(rest: string, width: number): Item | null {
  const ordered = ORDERED.exec(rest)
  const bullet = ordered ? null : BULLET.exec(rest)
  const match = ordered ?? bullet
  if (!match) return null
  const marker = ordered ? ordered[1]!.length + 1 : 1
  const spaces = (ordered ? ordered[3] : bullet![2]) ?? ""
  const body = (ordered ? ordered[4] : bullet![3]) ?? ""
  const empty = body.trim() === ""
  const gap = widthOf(spaces, width + marker)
  return {
    ordered: ordered !== null,
    delimiter: ordered ? ordered[2]! : bullet![1]!,
    start: ordered ? Number(ordered[1]) : 0,
    content: width + marker + (empty || gap > 4 ? 1 : gap),
    empty,
  }
}

/**
 * Places a list item in the open lists. Returns the lists after it and
 * its rendered number, or null when the line cannot start an item here
 * (a new list that would interrupt a paragraph must start at 1 and must
 * not be empty).
 */
function placeItem(state: BlockState, width: number, item: Item): { lists: OpenList[]; number: number } | null {
  const lists = [...state.lists]
  while (lists.length > 0) {
    const top = lists[lists.length - 1]!
    const parent = lists.length > 1 ? lists[lists.length - 2]!.content : 0
    if (width >= top.content) break
    if (width >= parent) {
      if (top.ordered === item.ordered && top.delimiter === item.delimiter) {
        lists[lists.length - 1] = { ...top, content: item.content, next: top.next + 1 }
        return { lists, number: top.next }
      }
      lists.pop()
      break
    }
    lists.pop()
  }
  const paragraph = state.previous === "text" || state.previous === "item"
  if (paragraph && (item.empty || (item.ordered && item.start !== 1))) return null
  lists.push({ ordered: item.ordered, delimiter: item.delimiter, content: item.content, next: item.start + 1 })
  return { lists, number: item.start }
}

/**
 * Classifies one line of Markdown, given the block state before it, and
 * returns the state after it. A small subset of CommonMark: fences, ATX
 * and setext headings, rules, tables, quotes and nested lists, with lazy
 * continuation lines. Ordered items get the number Markdown renders them
 * with, so `1.` repeated reads as a counted list.
 */
export function classifyLine(state: BlockState, raw: string): { info: LineInfo; next: BlockState } {
  const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
  const { width, length } = indentOf(line)
  const rest = line.slice(length)
  const done = (info: LineInfo, next: Partial<BlockState> = {}) => ({
    info,
    next: { ...state, ...next, previous: info.kind },
  })
  if (state.fence) {
    const close = FENCE_CLOSE.exec(rest)
    const fence = state.fence
    if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length && width - fence.base <= 3) {
      return done({ kind: "fence" }, { fence: null })
    }
    return done({ kind: "code" })
  }
  if (BLANK.test(line)) return done({ kind: "blank" })
  const base = containerOf(state.lists, width)
  if (width - base <= 3) {
    const open = FENCE_OPEN.exec(rest)
    if (open) {
      const marker = open[1] ?? open[2]!
      return done({ kind: "fence" }, { fence: { char: marker[0]!, length: marker.length, base }, lists: closeTo(state.lists, width) })
    }
    if (HEADING.test(rest)) return done({ kind: "heading" }, { lists: closeTo(state.lists, width) })
    if (state.previous === "text" && UNDERLINE.test(rest)) return done({ kind: "underline" })
    if (RULE.test(rest)) return done({ kind: "rule" }, { lists: closeTo(state.lists, width) })
    if (rest.startsWith("|")) return done({ kind: "table" }, { lists: closeTo(state.lists, width) })
    if (rest.startsWith(">")) return done({ kind: "quote" }, { lists: closeTo(state.lists, width) })
    const item = itemOf(rest, width)
    const placed = item ? placeItem(state, width, item) : null
    if (item && placed) {
      return done(item.ordered ? { kind: "item", number: placed.number } : { kind: "item" }, { lists: placed.lists })
    }
  }
  if (state.previous === "blank") return done({ kind: "text" }, { lists: closeTo(state.lists, width) })
  return done({ kind: "text" })
}

/**
 * Whether a line that starts with `prefix` opens a new block after a line
 * that left `state`: a heading, fence, table row, quote or list item.
 * Returns undefined while the prefix is too short to tell; `complete`
 * means the prefix is the whole line. Looks at no more than the
 * indentation and the block marker.
 */
export function opensBlock(state: BlockState, prefix: string, complete: boolean): boolean | undefined {
  const line = complete && prefix.endsWith("\r") ? prefix.slice(0, -1) : prefix
  if (BLANK.test(line)) return complete ? true : undefined
  const { width, length } = indentOf(line)
  if (width - containerOf(state.lists, width) > 3) return false
  const rest = line.slice(length)
  if (/^#{1,6}[ \t]/.test(rest) || (complete && /^#{1,6}$/.test(rest))) return true
  if (/^(?:`{3}|~{3})/.test(rest) || rest.startsWith("|")) return true
  if (rest.startsWith(">")) return state.previous !== "quote"
  if (/^[-+*][ \t]/.test(rest)) return true
  const ordered = /^(\d{1,9})([.)])(?:([ \t])|$)/.exec(rest)
  if (ordered && (complete || ordered[3] !== undefined)) {
    const item: Item = {
      ordered: true,
      delimiter: ordered[2]!,
      start: Number(ordered[1]),
      content: width + ordered[1]!.length + 2,
      empty: ordered[3] === undefined,
    }
    return placeItem(state, width, item) !== null
  }
  if (!complete && /^(?:#{1,6}|`{1,2}|~{1,2}|[-+*]|\d{1,9}[.)]?)$/.test(rest)) return undefined
  return false
}

/**
 * Whether a sentence end may cut a line that starts with `prefix` (the
 * line up to the sentence end) after a line that left `state`. Never in
 * code, headings, table rows and fence lines, nor right after the number
 * of an ordered list item. The sentence end must be followed by
 * whitespace.
 */
export function sentenceMayEnd(state: BlockState, prefix: string, token: string): boolean {
  if (state.fence) return false
  const { width, length } = indentOf(prefix)
  const rest = prefix.slice(length)
  if (width - containerOf(state.lists, width) > 3) return true
  if (/^(?:#{1,6}[ \t]|\||`{3}|~{3})/.test(rest)) return false
  if (token !== "." || !/^\d{1,9}$/.test(rest)) return true
  const item: Item = { ordered: true, delimiter: ".", start: Number(rest), content: width + rest.length + 2, empty: false }
  return placeItem(state, width, item) === null
}

/**
 * The words to speak for one line of a chunk: heading markers and setext
 * underlines are dropped (TTS reads `#` as "number") and ordered list
 * items carry the number Markdown renders them with. `segment` starts at
 * the line start or at its first non-blank character.
 */
export function spokenLine(segment: string, info: LineInfo, wholeLine: boolean): string {
  switch (info.kind) {
    case "heading": {
      const text = segment.replace(/^([ \t]*)#{1,6}(?:[ \t]+|$)/, "$1")
      return wholeLine ? text.replace(/(?:^|[ \t]+)#+[ \t]*(\r?)$/, "$1") : text
    }
    case "underline":
      return ""
    case "item":
      return info.number === undefined ? segment : segment.replace(/^([ \t]*)\d{1,9}/, `$1${info.number}`)
    default:
      return segment
  }
}
