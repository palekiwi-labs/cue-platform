import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"

export const SPEECH_MODES = ["off", "live"] as const

/** off; live: speak while the assistant message streams. */
export type SpeechMode = (typeof SPEECH_MODES)[number]

/** Custom session entry type recording each change of the session's speech mode. */
export const SPEECH_ENTRY = "cue-platform.speech-mode"

/** Kokoro voices a session can speak with, in menu order. */
export const SPEECH_VOICES = [
  { label: "Bella", id: "af_bella" },
  { label: "Heart", id: "af_heart" },
  { label: "Jessica", id: "af_jessica" },
  { label: "Sky", id: "af_sky" },
  { label: "Isabella", id: "bf_isabella" },
  { label: "Echo", id: "am_echo" },
] as const

/** Kokoro voice identifier sent with each speech chunk. */
export type SpeechVoice = (typeof SPEECH_VOICES)[number]["id"]

export const DEFAULT_SPEECH_VOICE: SpeechVoice = "af_bella"

/** Custom session entry type recording each change of the session's speech voice. */
export const SPEECH_VOICE_ENTRY = "cue-platform.speech-voice"

/** Footer status key that shows the speech mode while speech is on. */
export const SPEECH_STATUS_KEY = "speech"

function isSpeechMode(value: unknown): value is SpeechMode {
  return SPEECH_MODES.includes(value as SpeechMode)
}

/** The speech mode last recorded in a session's entries; off when none is. */
export function recordedSpeechMode(entries: readonly SessionEntry[]): SpeechMode {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry.type !== "custom" || entry.customType !== SPEECH_ENTRY) continue
    const mode = (entry.data as { mode?: unknown } | undefined)?.mode
    if (isSpeechMode(mode)) return mode
  }
  return "off"
}

function isSpeechVoice(value: unknown): value is SpeechVoice {
  return SPEECH_VOICES.some((voice) => voice.id === value)
}

/** The speech voice last recorded in a session's entries; Bella when none is. */
export function recordedSpeechVoice(entries: readonly SessionEntry[]): SpeechVoice {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry.type !== "custom" || entry.customType !== SPEECH_VOICE_ENTRY) continue
    const voice = (entry.data as { voice?: unknown } | undefined)?.voice
    if (isSpeechVoice(voice)) return voice
  }
  return DEFAULT_SPEECH_VOICE
}

/** Status text for a speech mode; none while speech is off. */
export function speechStatus(mode: SpeechMode): string | undefined {
  return mode === "off" ? undefined : `speech: ${mode}`
}

type RestoreContext = Pick<ExtensionContext, "mode" | "sessionManager" | "ui">

/**
 * The speech mode of the session one extension runtime serves. Off until
 * restored from the session at session start; each change is appended to
 * the session as a custom entry, so it survives resume and reload and
 * applies to no other session.
 */
export class SessionSpeechMode {
  private current: SpeechMode = "off"
  private ui: Pick<ExtensionContext["ui"], "setStatus"> | undefined

  constructor(private readonly pi: Pick<ExtensionAPI, "appendEntry">) {}

  get mode(): SpeechMode {
    return this.current
  }

  restore(ctx: RestoreContext): void {
    this.current = recordedSpeechMode(ctx.sessionManager.getEntries())
    this.ui = ctx.mode === "tui" ? ctx.ui : undefined
    this.show()
  }

  set(mode: SpeechMode): void {
    if (mode === this.current) return
    this.current = mode
    this.pi.appendEntry(SPEECH_ENTRY, { mode })
    this.show()
  }

  private show(): void {
    try {
      this.ui?.setStatus(SPEECH_STATUS_KEY, speechStatus(this.current))
    } catch {}
  }
}

/**
 * The speech voice of the session one extension runtime serves. Bella until
 * restored from the session at session start; each change is appended to
 * the session as a custom entry, so it survives resume and reload and
 * applies to no other session.
 */
export class SessionSpeechVoice {
  private current: SpeechVoice = DEFAULT_SPEECH_VOICE

  constructor(private readonly pi: Pick<ExtensionAPI, "appendEntry">) {}

  get voice(): SpeechVoice {
    return this.current
  }

  restore(ctx: Pick<ExtensionContext, "sessionManager">): void {
    this.current = recordedSpeechVoice(ctx.sessionManager.getEntries())
  }

  set(voice: SpeechVoice): void {
    if (voice === this.current) return
    this.current = voice
    this.pi.appendEntry(SPEECH_VOICE_ENTRY, { voice })
  }
}
