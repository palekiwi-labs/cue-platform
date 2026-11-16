import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import {
  recordedSpeechMode,
  recordedSpeechVoice,
  SessionSpeechMode,
  SessionSpeechVoice,
  SPEECH_ENTRY,
  SPEECH_VOICE_ENTRY,
  SPEECH_VOICES,
  speechStatus,
} from "./settings"

const custom = (customType: string, data?: unknown) => ({ type: "custom", customType, data }) as unknown as SessionEntry

describe("recordedSpeechMode", () => {
  test("is off for a session that never set speech", () => {
    expect(recordedSpeechMode([])).toBe("off")
  })

  test("takes the last valid speech entry", () => {
    expect(
      recordedSpeechMode([
        custom(SPEECH_ENTRY, { mode: "live" }),
        custom("other", { mode: "live" }),
        custom(SPEECH_ENTRY, { mode: "message" }),
        custom(SPEECH_ENTRY, { mode: "shout" }),
      ]),
    ).toBe("live")
    expect(recordedSpeechMode([custom(SPEECH_ENTRY, { mode: "live" }), custom(SPEECH_ENTRY, { mode: "off" })])).toBe(
      "off",
    )
  })
})

describe("SessionSpeechMode", () => {
  const previous = process.env.XDG_STATE_HOME
  afterEach(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
  })

  test("ignores the legacy global speech file", () => {
    const state = mkdtempSync(join(tmpdir(), "speech-"))
    mkdirSync(join(state, "cue-platform"))
    writeFileSync(join(state, "cue-platform", "speech.json"), JSON.stringify({ mode: "live" }))
    process.env.XDG_STATE_HOME = state
    const setting = new SessionSpeechMode({ appendEntry: () => {} } as unknown as ExtensionAPI)
    setting.restore({
      mode: "tui",
      sessionManager: { getEntries: () => [] },
      ui: { setStatus: () => {} },
    } as unknown as ExtensionContext)
    expect(setting.mode).toBe("off")
  })

  test("records only actual changes", () => {
    const appended: unknown[] = []
    const setting = new SessionSpeechMode({ appendEntry: (_t: string, d: unknown) => appended.push(d) } as never)
    setting.set("off")
    setting.set("live")
    setting.set("live")
    expect(appended).toEqual([{ mode: "live" }])
  })
})

describe("speech voices", () => {
  test("offers the six Kokoro voices in menu order", () => {
    expect(SPEECH_VOICES.map((v) => `${v.label} ${v.id}`)).toEqual([
      "Bella af_bella",
      "Heart af_heart",
      "Jessica af_jessica",
      "Sky af_sky",
      "Isabella bf_isabella",
      "Echo am_echo",
    ])
  })

  test("a session that never picked a voice speaks with Bella", () => {
    expect(recordedSpeechVoice([])).toBe("af_bella")
  })

  test("takes the last valid voice entry", () => {
    expect(
      recordedSpeechVoice([
        custom(SPEECH_VOICE_ENTRY, { voice: "af_sky" }),
        custom(SPEECH_ENTRY, { voice: "am_echo" }),
        custom(SPEECH_VOICE_ENTRY, { voice: "bf_emma" }),
      ]),
    ).toBe("af_sky")
  })

  test("restores from the session and records only actual changes", () => {
    const appended: unknown[] = []
    const setting = new SessionSpeechVoice({ appendEntry: (_t: string, d: unknown) => appended.push(d) } as never)
    setting.restore({
      sessionManager: { getEntries: () => [custom(SPEECH_VOICE_ENTRY, { voice: "bf_isabella" })] },
    } as unknown as ExtensionContext)
    expect(setting.voice).toBe("bf_isabella")
    setting.set("bf_isabella")
    setting.set("af_heart")
    expect(setting.voice).toBe("af_heart")
    expect(appended).toEqual([{ voice: "af_heart" }])
  })
})

describe("speechStatus", () => {
  test("names the mode only while speech is on", () => {
    expect(speechStatus("off")).toBeUndefined()
    expect(speechStatus("live")).toBe("speech: live")
  })
})
