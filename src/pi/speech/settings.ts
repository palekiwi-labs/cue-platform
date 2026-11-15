import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"

export const SPEECH_MODES = ["off", "live"] as const

/** off; live: speak while the assistant message streams. */
export type SpeechMode = (typeof SPEECH_MODES)[number]

/** Custom session entry type recording each change of the session's speech mode. */
export const SPEECH_ENTRY = "cue-platform.speech-mode"

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
