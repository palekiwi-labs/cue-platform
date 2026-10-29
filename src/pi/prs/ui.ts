/**
 * Structural UI contracts the PR picker renders through, so the same
 * components run inside pi (whose Theme and KeybindingsManager satisfy
 * them structurally) and in standalone host TUIs like cast-tui.
 */

/** Where picker open and new-session actions run. */
export type Target = "here" | "tmux"

export interface Theme {
  fg(color: string, text: string): string
  bg(color: string, text: string): string
  bold(text: string): string
}

/** Stand-in for the cue browser's session rows; structurally compatible. */
export interface SessionLike {
  address?: string
  modified: number
  path: string
  description: string
}

export interface Kb {
  matches(data: string, action: string): boolean
  getKeys(action: string): string[]
}
