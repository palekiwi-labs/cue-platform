import type { LiveEntry } from "./log-files"

/**
 * Which live entries a compaction rewrites. The newest `tail` entries
 * stay verbatim. Existing summaries are carried over unchanged, unless
 * there are `summaryCap` or more of them: then the two oldest are merged
 * again, from their archived originals. Everything else before the tail
 * is the head the compactor must replace.
 */

export interface CompactionLimits {
  /** Compact only when live entries exceed this. */
  threshold: number
  tail: number
  summaryCap: number
  /** Summaries one proposal may produce. */
  maxSummaries: number
}

export const DEFAULT_LIMITS: CompactionLimits = {
  threshold: 15,
  tail: 5,
  summaryCap: 3,
  maxSummaries: 2,
}

export interface Split {
  /** Files the proposal must replace, oldest first. */
  head: string[]
  /** Summaries rewritten from their archived originals. */
  merge: string[]
  /** Summaries kept unchanged. */
  carried: string[]
  tail: string[]
}

/** The split for a log, or null when there is nothing to compact. */
export function computeSplit(live: LiveEntry[], limits: CompactionLimits): Split | null {
  if (live.length <= limits.threshold) return null
  const before = live.slice(0, live.length - limits.tail)
  const tail = live.slice(live.length - limits.tail).map((e) => e.file)
  const summaries = before.filter((e) => e.entry.compacted).map((e) => e.file)
  const merge = summaries.length >= limits.summaryCap ? summaries.slice(0, 2) : []
  const carried = summaries.filter((f) => !merge.includes(f))
  const head = before.map((e) => e.file).filter((f) => !carried.includes(f))
  if (head.length === 0) return null
  return { head, merge, carried, tail }
}
