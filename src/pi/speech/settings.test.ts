import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { recordedSpeechMode, SessionSpeechMode, SPEECH_ENTRY, speechStatus } from "./settings"

const custom = (customType: string, data?: unknown) => ({ type: "custom", customType, data }) as unknown as SessionEntry

describe("recordedSpeechMode", () => {
  test("is off for a session that never set speech", () => {
    expect(recordedSpeechMode([])).toBe("off")
  })

  test("takes the last valid speech entry", () => {
    expect(
      recordedSpeechMode([
        custom(SPEECH_ENTRY, { mode: "live" }),
        custom("other", { mode: "message" }),
        custom(SPEECH_ENTRY, { mode: "message" }),
        custom(SPEECH_ENTRY, { mode: "shout" }),
      ]),
    ).toBe("message")
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

describe("speechStatus", () => {
  test("names the mode only while speech is on", () => {
    expect(speechStatus("off")).toBeUndefined()
    expect(speechStatus("message")).toBe("speech: message")
    expect(speechStatus("live")).toBe("speech: live")
  })
})
