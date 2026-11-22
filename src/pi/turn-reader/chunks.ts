const FENCE_OPEN = /^\s*(`{3,}(?=[^`]*$)|~{3,})/
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/
const FENCE_LINE = /^( {0,3})(`{3,}|~{3,})(.*)$/

/** A run of source lines rendered as one unit, dedented by `indent` columns. */
export interface SourceChunk {
  text: string
  indent: number
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function fenceLine(line: string): { pad: number; fence: string; info: string } | undefined {
  const match = FENCE_LINE.exec(line)
  if (!match) return undefined
  return { pad: match[1]!.length, fence: match[2]!, info: match[3]! }
}

function fencedContent(source: string): string | undefined {
  const lines = source.split("\n")
  const open = lines.length >= 2 ? fenceLine(lines[0]!) : undefined
  if (!open || (open.fence[0] === "`" && open.info.includes("`"))) return undefined
  const closes = (line: string) => {
    const close = fenceLine(line)
    return close !== undefined && close.fence[0] === open.fence[0] && close.fence.length >= open.fence.length && close.info.trim() === ""
  }
  const inner = lines.slice(1, -1)
  if (!closes(lines.at(-1)!) || inner.some(closes)) return undefined
  const content = inner.map((l) => l.slice(Math.min(open.pad, indentOf(l)))).join("\n")
  return content.trim() === "" ? undefined : content
}

function inlineContent(source: string): string | undefined {
  if (source.includes("\n")) return undefined
  const ticks = /^`+/.exec(source)?.[0]
  if (!ticks || source.length <= 2 * ticks.length) return undefined
  const inner = source.slice(ticks.length, -ticks.length)
  if (!source.endsWith(ticks) || inner.startsWith("`") || inner.endsWith("`")) return undefined
  if ((inner.match(/`+/g) ?? []).some((run) => run.length === ticks.length)) return undefined
  if (inner.trim() === "") return undefined
  return inner.length >= 2 && inner.startsWith(" ") && inner.endsWith(" ") ? inner.slice(1, -1) : inner
}

/**
 * The text to copy for a chunk's Markdown source: the content of a chunk
 * that is wholly one closed fenced code block or one inline code span,
 * without its fences, info string or backticks; otherwise the source as is.
 */
export function copyText(source: string): string {
  const trimmed = source.replace(/\s+$/, "").replace(/^(\s*\n)+/, "")
  return fencedContent(trimmed) ?? inlineContent(trimmed.trim()) ?? source
}

/**
 * Split Markdown source into chunks: runs of non-blank lines separated by
 * blank lines. Blank lines inside a fenced code block do not split it, and an
 * unclosed fence runs to the end. An indented chunk that continues a list
 * item is dedented so it renders as list content rather than as code, and
 * keeps its indent for display.
 */
export function sourceChunks(source: string): SourceChunk[] {
  const runs: string[][] = []
  let run: string[] = []
  let fence: string | undefined
  for (const line of source.replace(/\t/g, "   ").split(/\r?\n/)) {
    if (fence) {
      run.push(line)
      const close = FENCE_CLOSE.exec(line)?.[1]
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = undefined
      continue
    }
    if (line.trim() === "") {
      if (run.length > 0) runs.push(run)
      run = []
      continue
    }
    run.push(line)
    fence = FENCE_OPEN.exec(line)?.[1]
  }
  if (run.length > 0) runs.push(run)

  let inList = false
  return runs.map((lines) => {
    const indent = Math.min(...lines.filter((l) => l.trim() !== "").map(indentOf))
    const continues = inList && indent > 0
    inList = continues || LIST_ITEM.test(lines[0]!)
    if (!continues) return { text: lines.join("\n"), indent: 0 }
    return { text: lines.map((l) => l.slice(Math.min(indent, indentOf(l)))).join("\n"), indent }
  })
}
