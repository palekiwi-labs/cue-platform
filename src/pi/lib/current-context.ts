/**
 * The session's current cue context: the context most recently
 * associated on the active branch of the session tree. Two entry kinds
 * of type CUE_CONTEXT_TYPE associate one, both carrying the canonical
 * address:
 *
 * - an injection: a `custom_message` (seen by the model), address in
 *   `details`;
 * - a link: a `custom` entry from `pi.appendEntry` (never sent to the
 *   model), address in `data`.
 *
 * The newest of either wins, so the session history is the only state
 * store and forks or tree navigation follow it naturally.
 */

export const CUE_CONTEXT_TYPE = "cue-context"

export interface CueContextDetails {
  address: string
}

/** Minimal entry shape read from `sessionManager.getBranch()`. */
interface BranchEntry {
  type: string
  customType?: string
  details?: unknown
  data?: unknown
}

/** Last segment of a canonical context address (`org/repo/slug`). */
export function slugOf(address: string): string {
  const parts = address.split("/").filter((p) => p !== "")
  return parts[parts.length - 1] ?? ""
}

/**
 * Canonical address of the last cue-context injection or link on the
 * branch, or undefined when there is none.
 */
export function currentContext(
  branch: readonly BranchEntry[],
): string | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!
    if (e.customType !== CUE_CONTEXT_TYPE) continue
    const payload =
      e.type === "custom_message"
        ? e.details
        : e.type === "custom"
          ? e.data
          : undefined
    const address = (payload as Partial<CueContextDetails> | undefined)
      ?.address
    if (typeof address === "string" && address !== "") return address
  }
  return undefined
}
