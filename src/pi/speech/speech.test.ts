import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { FakeBridge } from "./fake-bridge"
import { registerSpeech, SPEECH_STOP_COMMAND, SPEECH_STOP_SHORTCUT, SUMMARIZER_ENV } from "./index"
import type { SpeechMode } from "./settings"

type Handler = (event: any, ctx: any) => unknown

const SENTENCE = "This reply is long enough to be spoken on its own."
const OTHER = "And this second reply is long enough to be spoken too."

let bridge: FakeBridge
let url: string
let mode: SpeechMode

function fakePi() {
  const handlers = new Map<string, Handler[]>()
  const commands = new Map<string, Handler>()
  const shortcuts = new Map<string, Handler>()
  const pi = {
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    registerCommand: (name: string, o: { handler: Handler }) => commands.set(name, o.handler),
    registerShortcut: (key: string, o: { handler: Handler }) => shortcuts.set(key, o.handler),
  } as unknown as ExtensionAPI
  return { pi, handlers, commands, shortcuts }
}

function setup(ctxMode = "tui") {
  const fake = fakePi()
  const speech = registerSpeech(fake.pi, { url, timeoutMs: 300, mode: () => mode })!
  const notes: string[] = []
  const controller = new AbortController()
  const ctx = { mode: ctxMode, signal: controller.signal, ui: { notify: (m: string) => notes.push(m) } }
  const emit = async (name: string, event: object = {}, c: object = ctx) => {
    for (const h of fake.handlers.get(name) ?? []) await h({ type: name, ...event }, c)
  }
  const assistant = (text: string, stopReason = "stop", extra: object[] = []) => ({
    role: "assistant",
    stopReason,
    content: [...extra, { type: "text", text }],
  })
  const reply = async (text: string, stopReason?: string, extra?: object[]) => {
    const message = assistant(text, stopReason, extra)
    await emit("message_start", { message })
    await emit("message_end", { message })
  }
  return { ...fake, speech, notes, controller, ctx, emit, reply }
}

beforeEach(async () => {
  bridge = new FakeBridge()
  url = await bridge.start()
  mode = "message"
})

afterEach(() => bridge.stopped())

describe("speaking messages", () => {
  test("speaks the text blocks of finished assistant messages only", async () => {
    const s = setup()
    await s.reply(SENTENCE, "stop", [{ type: "thinking", thinking: "secret thoughts here" }, { type: "toolCall" }])
    await s.emit("message_end", { message: { role: "user", content: [{ type: "text", text: OTHER }] } })
    await s.emit("message_end", { message: { role: "toolResult", content: [{ type: "text", text: OTHER }] } })
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`])
  })

  test("skips aborted and failed messages but speaks other stop reasons", async () => {
    const s = setup()
    await s.reply(OTHER, "aborted")
    await s.reply(OTHER, "error")
    await s.reply(SENTENCE, "length")
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`])
  })

  test("speaks live mode like message mode and nothing when off", async () => {
    const s = setup()
    mode = "live"
    await s.reply(SENTENCE)
    mode = "off"
    await s.reply(OTHER)
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`])
  })

  test("stays silent outside the TUI", async () => {
    for (const m of ["rpc", "json", "print"]) {
      const s = setup(m)
      await s.reply(SENTENCE)
      s.controller.abort()
      await s.emit("agent_settled", { aborted: true })
      await s.speech.sender.settled()
    }
    expect(bridge.paths()).toEqual([])
  })

  test("registers nothing in the turn summarizer", () => {
    process.env[SUMMARIZER_ENV] = "1"
    try {
      const fake = fakePi()
      expect(registerSpeech(fake.pi, { url })).toBeUndefined()
      expect(fake.handlers.size + fake.commands.size + fake.shortcuts.size).toBe(0)
    } finally {
      delete process.env[SUMMARIZER_ENV]
    }
  })

  test("warns once while the bridge is down and retries with the next message", async () => {
    const s = setup()
    bridge.sayStatus = 503
    await s.reply(`${SENTENCE} ${OTHER}`)
    await s.speech.sender.settled()
    await s.reply(SENTENCE)
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`, `/say ${SENTENCE}`])
    expect(s.notes.length).toBe(1)
    bridge.sayStatus = 202
    await s.reply(OTHER)
    await s.speech.sender.settled()
    bridge.sayStatus = 503
    await s.reply(SENTENCE)
    await s.speech.sender.settled()
    expect(s.notes.length).toBe(2)
  })
})

describe("stopping", () => {
  test("registers /speech-stop and the stop key", () => {
    const s = setup()
    expect([...s.commands.keys()]).toEqual([SPEECH_STOP_COMMAND])
    expect([...s.shortcuts.keys()]).toEqual([SPEECH_STOP_SHORTCUT])
  })

  test("the command stops at once and mutes the rest of the current message", async () => {
    const s = setup()
    const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: SENTENCE }] }
    await s.emit("message_start", { message })
    await s.commands.get(SPEECH_STOP_COMMAND)!("", s.ctx)
    await s.emit("message_end", { message })
    await s.reply(OTHER)
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual(["/stop", `/say ${OTHER}`])
  })

  test("the stop key drops queued sentences", async () => {
    const s = setup()
    bridge.holdSay = true
    await s.reply(`${SENTENCE} ${OTHER}`)
    await bridge.received(1)
    s.shortcuts.get(SPEECH_STOP_SHORTCUT)!(s.ctx, undefined)
    bridge.release()
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`, "/stop", "/stop"])
  })

  test("an interrupt during tools stops at once and the next message speaks", async () => {
    const s = setup()
    bridge.holdSay = true
    await s.emit("agent_start")
    await s.reply(`${SENTENCE} ${OTHER}`, "toolUse")
    await bridge.received(1)
    s.controller.abort()
    await bridge.received(2)
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`, "/stop"])
    bridge.holdSay = false
    bridge.release()
    await s.reply(OTHER, "aborted")
    await s.emit("agent_end")
    await s.emit("agent_settled", { aborted: true })
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`, "/stop", "/stop", "/stop"])
    const next = new AbortController()
    await s.emit("agent_start", {}, { ...s.ctx, signal: next.signal })
    await s.reply(SENTENCE)
    await s.speech.sender.settled()
    expect(bridge.paths().at(-1)).toBe(`/say ${SENTENCE}`)
  })

  test("a signal already aborted at agent_start stops at once", async () => {
    const s = setup()
    s.controller.abort()
    await s.emit("agent_start")
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual(["/stop"])
  })

  test("the abort listener is detached at the end of the run", async () => {
    const s = setup()
    await s.emit("agent_start")
    await s.emit("agent_end")
    s.controller.abort()
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([])
  })

  test("agent_settled with aborted stops even between runs", async () => {
    const s = setup()
    await s.emit("agent_settled", { aborted: false })
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([])
    await s.emit("agent_settled", { aborted: true })
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual(["/stop"])
  })

  test("an interrupt does not reach the bridge when speech is off and unused", async () => {
    const s = setup()
    mode = "off"
    await s.emit("agent_start")
    s.controller.abort()
    await s.emit("agent_settled", { aborted: true })
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([])
  })

  test("session shutdown stops speech", async () => {
    const s = setup()
    await s.reply(SENTENCE)
    await s.speech.sender.settled()
    await s.emit("session_shutdown", { reason: "quit" })
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`, "/stop"])
  })
})
