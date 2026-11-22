import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { DEFAULT_THRESHOLDS, type Thresholds } from "./context-usage"

/** Why a set of thresholds was rejected, or null when it is valid. */
export function thresholdsError(t: Thresholds, contextWindow?: number): string | null {
  const values = [t.caution, t.soft, t.hard]
  if (!values.every((v) => Number.isInteger(v) && v > 0)) {
    return "thresholds must be positive whole token counts"
  }
  if (!(t.caution < t.soft)) return "caution must be below soft"
  if (!(t.soft < t.hard)) return "soft must be below hard"
  if (contextWindow !== undefined && t.hard > contextWindow) {
    return `hard must not exceed the context window (${contextWindow.toLocaleString("en-US")})`
  }
  return null
}

/** Custom entry type carrying the session's thresholds in its `data`. */
export const THRESHOLDS_TYPE = "cue-thresholds"

/** Minimal entry shape read from `sessionManager.getBranch()`. */
interface BranchEntry {
  type: string
  customType?: string
  data?: unknown
}

/**
 * The thresholds most recently set on the branch, or the defaults when
 * none is set. The session history is the only state store, so resume,
 * fork and tree navigation follow it.
 */
export function sessionThresholds(branch: readonly BranchEntry[]): Thresholds {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!
    if (e.type !== "custom" || e.customType !== THRESHOLDS_TYPE) continue
    const d = e.data as Partial<Thresholds> | undefined
    const t = { caution: d?.caution, soft: d?.soft, hard: d?.hard } as Thresholds
    if (thresholdsError(t) === null) return t
  }
  return { ...DEFAULT_THRESHOLDS }
}

/** Anything exposing the session branch, e.g. a tool or command context. */
export interface HasSession {
  sessionManager?: { getBranch?: () => readonly BranchEntry[] }
}

/** The effective thresholds of the session behind a context. */
export function thresholdsOf(ctx: HasSession): Thresholds {
  const branch = typeof ctx.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : []
  return sessionThresholds(branch)
}

/** Validate and record thresholds in the session; returns the validation error, if any. */
export function setSessionThresholds(
  pi: Pick<ExtensionAPI, "appendEntry">,
  t: Thresholds,
  contextWindow?: number,
): string | null {
  const error = thresholdsError(t, contextWindow)
  if (error === null) pi.appendEntry(THRESHOLDS_TYPE, { caution: t.caution, soft: t.soft, hard: t.hard })
  return error
}
