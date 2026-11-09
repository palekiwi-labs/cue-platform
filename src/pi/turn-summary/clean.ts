/**
 * Reduce a summary to plain speakable prose: one paragraph without
 * markdown, code, paths, URLs or stray symbols.
 */
export function cleanSummary(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\bhttps?:\/\/\S+/g, " ")
    .replace(/(^|\s)(?:~|\.{1,2})?\/?(?:[\w.@-]+\/)+[\w.@-]*/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|\*|_)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/[`*_#<>|\\{}[\]~^=$]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .trim()
}
