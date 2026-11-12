const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/
const SHORT_CODE = /^\/?[\w.@:-]{1,24}(?:\(\))?$/
const PATH =
  /(^|\s)(?:(?:~|\.{1,2})\/(?:[\w.@-]+\/?)*|\/[\w.@-]+\/[\w.@/-]*|[\w.@-]+\/(?:[\w.@-]+\/)+[\w.@-]*|[\w.@-]+\/[\w@-]*\.[\w.@-]*|[\w.@-]+\/(?=\s|$))/g

/**
 * Replace fenced code blocks (backtick or tilde, closed or not) and table
 * rows with blank lines, leaving the other lines as they are.
 */
export function dropCodeAndTables(raw: string): string {
  const out: string[] = []
  let fence: { char: string; length: number } | null = null
  for (const line of raw.split("\n")) {
    if (fence) {
      const close = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/)
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = null
      continue
    }
    const open = line.match(FENCE_OPEN)
    if (open) {
      fence = { char: open[1]![0]!, length: open[1]!.length }
      out.push("")
    } else if (TABLE_ROW.test(line) || TABLE_RULE.test(line)) {
      out.push("")
    } else {
      out.push(line)
    }
  }
  return out.join("\n")
}

/** Reduce one paragraph of markdown to plain speakable prose on one line. */
export function cleanParagraph(raw: string): string {
  return raw
    .replace(/`([^`\n]*)`/g, (_, code: string) => (SHORT_CODE.test(code.trim()) ? code.trim() : " "))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\bhttps?:\/\/\S+/g, " ")
    .replace(PATH, "$1")
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|\*|_)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/[`*_#<>|\\{}[\]~^=$]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
    .replace(/\(\s*[,;:]?\s*\)/g, "")
    .replace(/\(\s*[,;:]?\s*/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim()
}

/**
 * Reduce markdown to plain speakable prose: short paragraphs separated by a
 * blank line, without markdown, code, tables, paths, URLs, commit hashes or
 * stray symbols.
 */
export function speakableText(raw: string): string {
  return dropCodeAndTables(raw)
    .split(/\n\s*\n/)
    .map(cleanParagraph)
    .filter((p) => p !== "")
    .join("\n\n")
}
