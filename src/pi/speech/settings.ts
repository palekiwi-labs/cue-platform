import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const STATE_FILE = join(
  process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
  "cue-platform",
  "speech.json",
)

export const SPEECH_MODES = ["off", "message", "live"] as const

/** off; message: speak each assistant message once it ends; live: speak while it streams. */
export type SpeechMode = (typeof SPEECH_MODES)[number]

interface SpeechState {
  mode?: string
}

function readState(file: string): SpeechState {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SpeechState
  } catch {
    return {}
  }
}

/** The global speech mode shared by every pi session; off by default. */
export function speechMode(file = STATE_FILE): SpeechMode {
  const mode = readState(file).mode
  return SPEECH_MODES.includes(mode as SpeechMode) ? (mode as SpeechMode) : "off"
}

export function setSpeechMode(mode: SpeechMode, file = STATE_FILE): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ ...readState(file), mode }) + "\n")
}
