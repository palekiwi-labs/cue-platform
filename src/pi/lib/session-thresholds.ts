import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { type DefaultsSource, resolveDefaults } from "./config"
import { contextMode } from "./context-mode"
import { currentContext } from "./current-context"
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
  details?: unknown
}

/**
 * The thresholds most recently set on the branch, or `defaults` when
 * none is set. The session history is the only state store, so resume,
 * fork and tree navigation follow it.
 */
export function sessionThresholds(
  branch: readonly BranchEntry[],
  defaults: Thresholds = DEFAULT_THRESHOLDS,
): Thresholds {
  return ownThresholds(branch) ?? { ...defaults }
}

/** Anything exposing the session branch, e.g. a tool or command context. */
export interface HasSession {
  sessionManager?: { getBranch?: () => readonly BranchEntry[] }
}

/** Where a session's effective thresholds come from. */
export type ThresholdsSource = { kind: "session" } | DefaultsSource

/** The session's mode: the `mode:` of its linked cue context, if any. */
export function sessionMode(branch: readonly BranchEntry[]): string | undefined {
  const address = currentContext(branch)
  return address === undefined ? undefined : contextMode(address)
}

/** The thresholds set with /thresholds on the branch, if any. */
export function ownThresholds(branch: readonly BranchEntry[]): Thresholds | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!
    if (e.type !== "custom" || e.customType !== THRESHOLDS_TYPE) continue
    const d = e.data as Partial<Thresholds> | undefined
    const t = { caution: d?.caution, soft: d?.soft, hard: d?.hard } as Thresholds
    if (thresholdsError(t) === null) return t
  }
  return undefined
}

function branchOf(ctx: HasSession): readonly BranchEntry[] {
  return typeof ctx.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : []
}

/** The effective thresholds of a session, the defaults for its mode, and their source. */
export function resolveThresholds(ctx: HasSession): {
  thresholds: Thresholds
  defaults: Thresholds
  source: ThresholdsSource
} {
  const branch = branchOf(ctx)
  const d = resolveDefaults(sessionMode(branch))
  const own = ownThresholds(branch)
  if (own) return { thresholds: own, defaults: d.thresholds, source: { kind: "session" } }
  return { thresholds: d.thresholds, defaults: d.thresholds, source: d.source }
}

/** Effective thresholds of a session given its own entry and linked context, as read from its file. */
export function storedThresholds(own: Thresholds | undefined, address: string | undefined): Thresholds {
  return own ?? resolveDefaults(address === undefined ? undefined : contextMode(address)).thresholds
}

/** The effective thresholds of the session behind a context. */
export function thresholdsOf(ctx: HasSession): Thresholds {
  return resolveThresholds(ctx).thresholds
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
