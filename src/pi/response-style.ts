import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>

/** Directory holding one `<name>.md` file per response style. */
export const STYLES_DIR = join(homedir(), ".config", "cue", "styles")

/** The style that is always listed; it adds nothing unless default.md exists. */
export const DEFAULT_STYLE = "default"

const STATE = Symbol.for("cue-platform.response-style")
interface StyleState {
  active: string
  restoreThinking?: ThinkingLevel
  appliedThinking?: ThinkingLevel
  applying?: boolean
}
const state = ((globalThis as Record<symbol, StyleState>)[STATE] ??= { active: DEFAULT_STYLE })

/** Request settings a style may declare in its frontmatter. */
export interface StyleSettings {
  verbosity?: string
  thinking?: ThinkingLevel
}

/** A style file split into frontmatter settings and instruction body. */
export interface StyleFile {
  settings: StyleSettings
  instruction: string
}

const OPENAI_RESPONSES_APIS = new Set(["openai-responses", "openai-codex-responses", "azure-openai-responses"])

/** Name of the session's active style. */
export function activeStyle(): string {
  return state.active
}

export function setActiveStyle(name: string): void {
  state.active = name
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

/** Split flat `key: value` frontmatter from the body of a style file. */
export function parseStyle(text: string): StyleFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) return { settings: {}, instruction: text.trim() }
  const fields: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^\s*([\w-]+)\s*:\s*(.*?)\s*$/.exec(line)
    if (kv && kv[2]) fields[kv[1]!] = kv[2].replace(/^["']|["']$/g, "")
  }
  const settings: StyleSettings = {}
  if (fields.verbosity) settings.verbosity = fields.verbosity
  if (fields.thinking) settings.thinking = fields.thinking as ThinkingLevel
  return { settings, instruction: text.slice(match[0].length).trim() }
}

/** The parsed style file; empty when it is missing or unreadable. */
export function readStyle(name: string, dir = STYLES_DIR): StyleFile {
  try {
    return parseStyle(readFileSync(join(dir, `${name}.md`), "utf8"))
  } catch {
    return { settings: {}, instruction: "" }
  }
}

/** The style's instruction text; empty when its file is missing or unreadable. */
export function styleInstruction(name: string, dir = STYLES_DIR): string {
  return readStyle(name, dir).instruction
}

/**
 * Activate a style and apply its thinking level. The level in effect before
 * the first style that sets one is restored when switching to a style that
 * sets none, unless the operator changed the level by hand in between.
 */
export function switchStyle(pi: ExtensionAPI, name: string, dir = STYLES_DIR): void {
  state.active = name
  const { thinking } = readStyle(name, dir).settings
  if (thinking) {
    state.restoreThinking ??= pi.getThinkingLevel()
    state.applying = true
    try {
      pi.setThinkingLevel(thinking)
    } finally {
      state.applying = false
    }
    state.appliedThinking = pi.getThinkingLevel()
  } else if (state.restoreThinking) {
    const restore = state.restoreThinking
    state.restoreThinking = undefined
    state.appliedThinking = undefined
    pi.setThinkingLevel(restore)
  }
}

/** The payload with the style's text verbosity set, for OpenAI Responses APIs. */
export function withVerbosity(payload: unknown, api: string | undefined, verbosity: string | undefined): unknown {
  if (!verbosity || !api || !OPENAI_RESPONSES_APIS.has(api)) return undefined
  if (!payload || typeof payload !== "object") return undefined
  const body = payload as { text?: Record<string, unknown> }
  return { ...body, text: { ...body.text, verbosity } }
}

/** The system prompt with the style's instruction appended, if it has one. */
export function withResponseStyle(systemPrompt: string, name: string, instruction: string): string {
  if (!instruction) return systemPrompt
  return `${systemPrompt}\n\n<response_style name="${name}">\n${instruction}\n</response_style>`
}

/**
 * Append the active response style to the system prompt on every agent turn
 * and apply its verbosity to OpenAI Responses requests. The style file is
 * re-read each time, so edits apply without a reload.
 */
export function registerResponseStyle(pi: ExtensionAPI, dir = STYLES_DIR): void {
  pi.on("before_agent_start", async (event) => {
    const instruction = styleInstruction(state.active, dir)
    if (!instruction) return undefined
    return { systemPrompt: withResponseStyle(event.systemPrompt, state.active, instruction) }
  })
  pi.on("before_provider_request", (event, ctx) => {
    const { verbosity } = readStyle(state.active, dir).settings
    return withVerbosity(event.payload, ctx.model?.api, verbosity)
  })
  pi.on("thinking_level_select", (event) => {
    if (!state.applying && state.appliedThinking && event.level !== state.appliedThinking) {
      state.restoreThinking = undefined
      state.appliedThinking = undefined
    }
  })
}
