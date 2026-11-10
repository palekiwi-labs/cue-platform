function cleanParagraph(raw: string): string {
  return raw
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\bhttps?:\/\/\S+/g, " ")
    .replace(/(^|\s)(?:~|\.{1,2})?\/?(?:[\w.@-]+\/)+[\w.@-]*/g, "$1")
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|\*|_)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/[`*_#<>|\\{}[\]~^=$]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .trim()
}

/**
 * Reduce a summary to plain speakable prose: short paragraphs separated by
 * a blank line, without markdown, code, paths, URLs, commit hashes or stray
 * symbols.
 */
export function cleanSummary(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\n\s*\n/)
    .map(cleanParagraph)
    .filter((p) => p !== "")
    .join("\n\n")
}
