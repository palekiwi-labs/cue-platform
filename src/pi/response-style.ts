import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/** A named instruction that shapes how the agent's replies read. */
export interface ResponseStyle {
  name: string
  /** Text added to the system prompt; empty for the default style. */
  instruction: string
}

export const RESPONSE_STYLES: ResponseStyle[] = [
  { name: "default", instruction: "" },
  {
    name: "gangsta",
    instruction: [
      "Write every reply in an exaggerated gangsta rap voice: street slang,",
      "swagger, calling the operator 'homie'. Keep code, commands, paths and",
      "tool calls exactly correct; only the prose changes.",
    ].join("\n"),
  },
]

let active = 0

/** Index of the session's active style in RESPONSE_STYLES. */
export function activeStyle(): number {
  return active
}

export function setActiveStyle(index: number): void {
  if (index >= 0 && index < RESPONSE_STYLES.length) active = index
}

/** The system prompt with the style's instruction appended, if it has one. */
export function withResponseStyle(systemPrompt: string, style: ResponseStyle): string {
  if (!style.instruction) return systemPrompt
  return `${systemPrompt}\n\n<response_style name="${style.name}">\n${style.instruction}\n</response_style>`
}

/**
 * Append the active response style to the system prompt on every agent turn.
 * The style is chosen per session from the settings menu, so a change takes
 * effect from the next turn.
 */
export function registerResponseStyle(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    const style = RESPONSE_STYLES[active]!
    if (!style.instruction) return undefined
    return { systemPrompt: withResponseStyle(event.systemPrompt, style) }
  })
}
