import { SPEECH_MODES, type SpeechMode } from "./settings"

/** Whether the speech status text says speech is on; false while it is off. */
export function speechActive(text: string | undefined): boolean {
  const mode = text?.trim().replace(/^speech:\s*/, "") as SpeechMode | undefined
  return !!mode && mode !== "off" && SPEECH_MODES.includes(mode)
}
