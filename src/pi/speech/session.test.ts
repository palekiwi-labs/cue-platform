import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { sessionSettings } from "../commands/session-menus"
import { FakeBridge } from "./fake-bridge"
import { registerSpeech } from "./index"
import { SPEECH_ENTRY, SPEECH_STATUS_KEY, type SpeechMode } from "./settings"

type Handler = (event: any, ctx: any) => unknown
type Entry = { type: string; customType?: string; data?: unknown }

const SENTENCE = "This reply is long enough to be spoken on its own."
const OTHER = "And this second reply is long enough to be spoken too."

let bridge: FakeBridge
let url: string

beforeEach(async () => {
  bridge = new FakeBridge()
  url = await bridge.start()
})

afterEach(() => bridge.stopped())

/** One pi extension runtime serving one session, whose entries it shares with the caller. */
function runtime(entries: Entry[] = [], ctxMode = "tui") {
  const handlers = new Map<string, Handler[]>()
  const pi = {
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    registerCommand: () => {},
    registerShortcut: () => {},
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    getThinkingLevel: () => "medium",
  } as unknown as ExtensionAPI
  const speech = registerSpeech(pi, { url, timeoutMs: 300 })!
  const statuses = new Map<string, string | undefined>()
  const controller = new AbortController()
  const ctx = {
    mode: ctxMode,
    signal: controller.signal,
    sessionManager: { getEntries: () => entries },
    ui: { notify: () => {}, setStatus: (key: string, text: string | undefined) => statuses.set(key, text) },
  }
  const emit = async (name: string, event: object = {}) => {
    for (const h of handlers.get(name) ?? []) await h({ type: name, ...event }, ctx)
  }
  const message = (content: object[] = [], stopReason?: string) => ({ role: "assistant", stopReason, content })
  const reply = async (text: string) => {
    await emit("message_start", { message: message() })
    await emit("message_end", { message: message([{ type: "text", text }], "stop") })
  }
  const pick = (mode: SpeechMode) => {
    const setting = sessionSettings(pi, speech.setting).find((s) => s.label === "speech")!
    setting.apply(setting.values.indexOf(mode))
  }
  const shown = () => sessionSettings(pi, speech.setting).find((s) => s.label === "speech")!
  return { pi, speech, entries, statuses, controller, ctx, emit, message, reply, pick, shown }
}

async function started(entries: Entry[] = [], reason = "startup", ctxMode = "tui") {
  const r = runtime(entries, ctxMode)
  await r.emit("session_start", { reason })
  return r
}

describe("per-session speech mode", () => {
  test("a new session starts with speech off and shows no indicator", async () => {
    const s = await started([], "new")
    expect(s.speech.setting!.mode).toBe("off")
    expect(s.shown().values[s.shown().current]).toBe("off")
    expect(s.statuses.get(SPEECH_STATUS_KEY)).toBeUndefined()
    await s.reply(SENTENCE)
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([])
  })

  test("F3 and the speaker read and change the same session mode", async () => {
    const s = await started()
    s.pick("live")
    expect(s.speech.setting!.mode).toBe("live")
    expect(s.shown().values[s.shown().current]).toBe("live")
    expect(s.entries).toEqual([{ type: "custom", customType: SPEECH_ENTRY, data: { mode: "live" } }])
    expect(s.statuses.get(SPEECH_STATUS_KEY)).toBe("speech: live")
    await s.reply(SENTENCE)
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`])
    s.pick("off")
    expect(s.statuses.get(SPEECH_STATUS_KEY)).toBeUndefined()
    s.pick("live")
    expect(s.statuses.get(SPEECH_STATUS_KEY)).toBe("speech: live")
    expect(s.entries.length).toBe(3)
  })

  test("enabling one session leaves another session off", async () => {
    const a = await started([])
    const b = await started([])
    a.pick("live")
    expect(b.speech.setting!.mode).toBe("off")
    expect(b.statuses.get(SPEECH_STATUS_KEY)).toBeUndefined()
    await b.reply(OTHER)
    await b.speech.sender.settled()
    await a.reply(SENTENCE)
    await a.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`])
    const fresh = await started([], "new")
    expect(fresh.speech.setting!.mode).toBe("off")
  })

  test("resume and reload restore the mode the session last recorded", async () => {
    const entries: Entry[] = []
    const first = await started(entries)
    first.pick("live")
    first.pick("off")
    first.pick("live")
    for (const reason of ["resume", "reload", "startup"]) {
      const again = await started(entries, reason)
      expect(again.speech.setting!.mode).toBe("live")
      expect(again.shown().values[again.shown().current]).toBe("live")
      expect(again.statuses.get(SPEECH_STATUS_KEY)).toBe("speech: live")
    }
  })

  test("a fork keeps the mode recorded on its path, like the thinking level", async () => {
    const parent = await started([])
    parent.pick("live")
    const fork = await started([...parent.entries], "fork")
    expect(fork.speech.setting!.mode).toBe("live")
    fork.pick("off")
    expect(parent.speech.setting!.mode).toBe("live")
  })

  test("unknown or foreign entries do not turn speech on", async () => {
    const s = await started([
      { type: "custom", customType: "other-extension", data: { mode: "live" } },
      { type: "custom", customType: SPEECH_ENTRY, data: { mode: "shout" } },
      { type: "custom", customType: SPEECH_ENTRY },
    ])
    expect(s.speech.setting!.mode).toBe("off")
  })

  test("switching away stops the old session's playback and the next session stays off", async () => {
    const a = await started([])
    a.pick("live")
    await a.reply(SENTENCE)
    await a.speech.sender.settled()
    await a.emit("session_shutdown", { reason: "resume" })
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`, "/stop"])
    const b = await started([], "resume")
    await b.emit("agent_start")
    b.controller.abort()
    await b.emit("agent_settled", { aborted: true })
    await b.reply(OTHER)
    await b.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`, "/stop"])
  })

  test("a session switch with speech off and unused sends nothing", async () => {
    const s = await started([])
    await s.emit("session_shutdown", { reason: "new" })
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([])
  })

  test("toggling while a message streams follows the per-message rules", async () => {
    const s = await started([])
    const update = (assistantMessageEvent: object) =>
      s.emit("message_update", { message: s.message(), assistantMessageEvent })
    s.pick("live")
    await s.emit("message_start", { message: s.message() })
    await update({ type: "text_delta", contentIndex: 0, delta: `${SENTENCE} ` })
    await bridge.received(1)
    s.pick("off")
    await update({ type: "text_delta", contentIndex: 0, delta: `${OTHER} ` })
    await s.emit("message_end", { message: s.message([{ type: "text", text: `${SENTENCE} ${OTHER} ` }], "stop") })
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`])
    await s.emit("message_start", { message: s.message() })
    s.pick("live")
    await update({ type: "text_delta", contentIndex: 0, delta: `${OTHER} ` })
    await s.emit("message_end", { message: s.message([{ type: "text", text: `${OTHER} ` }], "stop") })
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`])
    await s.reply(OTHER)
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`, `/say ${OTHER}`])
  })

  test("a restored mode stays silent and shows no indicator outside the TUI", async () => {
    const entries: Entry[] = [{ type: "custom", customType: SPEECH_ENTRY, data: { mode: "live" } }]
    const s = await started(entries, "startup", "json")
    expect(s.statuses.size).toBe(0)
    await s.reply(SENTENCE)
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([])
  })
})
