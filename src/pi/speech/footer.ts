import { SPEECH_MODES, type SpeechMode } from "./settings"

interface MarkerTheme {
  fg(color: "accent" | "warning", text: string): string
  bold(text: string): string
}

const COLORS: Record<Exclude<SpeechMode, "off">, "accent" | "warning"> = {
  live: "warning",
}

/** The footer's speech indicator for the speech status text; empty while speech is off. */
export function speechMarker(text: string | undefined, theme: MarkerTheme): string {
  const mode = text?.trim().replace(/^speech:\s*/, "") as SpeechMode | undefined
  if (!mode || mode === "off" || !SPEECH_MODES.includes(mode)) return ""
  return theme.bold(theme.fg(COLORS[mode], `speech: ${mode}`))
}
