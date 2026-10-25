/** Where picker open and new-session actions run. */
export type Target = "here" | "tmux"

interface EntryLike {
  type: string
  message?: { role?: string }
}

/**
 * Default target for pickers: "here" while the session has no conversation
 * yet (fresh pi, /new, or only injected context), "tmux" once it does, so an
 * action never replaces a session with work in it. Mirrors pi's own
 * SessionManager rule for when a session is written to disk.
 */
export function defaultTarget(entries: readonly EntryLike[]): Target {
  const conversed = entries.some(
    (e) => e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant"),
  )
  return conversed ? "tmux" : "here"
}
