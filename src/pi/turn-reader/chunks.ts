const FENCE_OPEN = /^\s*(`{3,}(?=[^`]*$)|~{3,})/
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/

/** A run of source lines rendered as one unit, dedented by `indent` columns. */
export interface SourceChunk {
  text: string
  indent: number
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
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
