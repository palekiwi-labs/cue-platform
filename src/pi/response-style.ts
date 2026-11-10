import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/** Directory holding one `<name>.md` file per response style. */
export const STYLES_DIR = join(homedir(), ".config", "cue", "styles")

/** The built-in style that adds no instruction. */
export const DEFAULT_STYLE = "default"

let active = DEFAULT_STYLE

/** Name of the session's active style. */
export function activeStyle(): string {
  return active
}

export function setActiveStyle(name: string): void {
  active = name
}

/** Style names: the default first, then each `.md` file in dir, sorted. */
export function listStyles(dir = STYLES_DIR): string[] {
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"))
  } catch {
    files = []
  }
  const names = files.map((f) => basename(f, ".md")).filter((n) => n !== DEFAULT_STYLE)
  return [DEFAULT_STYLE, ...names.sort()]
}

/** The style's instruction text; empty for the default or an unreadable file. */
export function styleInstruction(name: string, dir = STYLES_DIR): string {
  if (name === DEFAULT_STYLE) return ""
  try {
    return readFileSync(join(dir, `${name}.md`), "utf8").trim()
  } catch {
    return ""
  }
}

/** The system prompt with the style's instruction appended, if it has one. */
export function withResponseStyle(systemPrompt: string, name: string, instruction: string): string {
  if (!instruction) return systemPrompt
  return `${systemPrompt}\n\n<response_style name="${name}">\n${instruction}\n</response_style>`
}

/**
 * Append the active response style to the system prompt on every agent turn.
 * The style file is re-read each turn, so edits apply without a reload.
 */
export function registerResponseStyle(pi: ExtensionAPI, dir = STYLES_DIR): void {
  pi.on("before_agent_start", async (event) => {
    const instruction = styleInstruction(active, dir)
    if (!instruction) return undefined
    return { systemPrompt: withResponseStyle(event.systemPrompt, active, instruction) }
  })
}
