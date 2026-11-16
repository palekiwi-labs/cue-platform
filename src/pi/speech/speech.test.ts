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
  mode = "live"
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

  test("sends every text block as written, code, tables and links included", async () => {
    const s = setup()
    const first = "Run `bun test ./src` in ~/code/x, see [docs](https://example.com/a_b)."
    const second = "| a | b |\n|---|---|\n| 1 | 2 |\n```sh\nrm -rf ./build\n```"
    const message = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: first }, { type: "toolCall" }, { type: "text", text: second }],
    }
    await s.emit("message_start", { message })
    await s.emit("message_end", { message })
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${first}`, `/say ${second.slice(0, -4)}`, "/say ```"])
  })

  test("skips aborted and failed messages but speaks other stop reasons", async () => {
    const s = setup()
    await s.reply(OTHER, "aborted")
    await s.reply(OTHER, "error")
    await s.reply(SENTENCE, "length")
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`])
  })

  test("live mode speaks a message that arrives without deltas, off speaks nothing", async () => {
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

type Block = { type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; name: string }

function streaming(s: ReturnType<typeof setup>, c: object = s.ctx) {
  const message = (content: Block[] = [], stopReason?: string) => ({ role: "assistant", stopReason, content })
  const update = (assistantMessageEvent: object) =>
    s.emit("message_update", { message: message(), assistantMessageEvent }, c)
  return {
    start: () => s.emit("message_start", { message: message() }, c),
    delta: (contentIndex: number, delta: string) => update({ type: "text_delta", contentIndex, delta }),
    textEnd: (contentIndex: number, content: string) => update({ type: "text_end", contentIndex, content }),
    thinking: (contentIndex: number, delta: string) => update({ type: "thinking_delta", contentIndex, delta }),
    toolCall: (contentIndex: number, delta: string) => update({ type: "toolcall_delta", contentIndex, delta }),
    end: (content: Block[], stopReason = "stop") => s.emit("message_end", { message: message(content, stopReason) }, c),
  }
}

const text = (t: string): Block => ({ type: "text", text: t })
const settle = () => new Promise((r) => setTimeout(r, 20))

describe("live mode", () => {
  beforeEach(() => {
    mode = "live"
  })

  test("sends completed chunks before the message ends", async () => {
    const s = setup()
    const m = streaming(s)
    await m.start()
    await m.delta(0, SENTENCE.slice(0, 20))
    await m.delta(0, `${SENTENCE.slice(20)} And then`)
    await bridge.received(1)
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`])
    await m.delta(0, " the rest")
    await m.textEnd(0, `${SENTENCE} And then the rest`)
    await m.end([text(`${SENTENCE} And then the rest`)])
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`, "/say And then the rest"])
  })

  test("a message split at any boundary sends the same chunks as a whole one", async () => {
    const reply = `${SENTENCE} See \`src/a.ts\` and https://example.com/x.y?z=1.\n| a | b |\n\`\`\`\ncode. more\n\`\`\`\n${OTHER}`
    const whole = setup()
    await whole.reply(reply)
    await whole.speech.sender.settled()
    const expected = bridge.paths()
    expect(expected.join("\n")).toContain("https://example.com/x.y?z=1.")
    for (let i = 0; i <= reply.length; i++) {
      bridge.requests.splice(0)
      const s = setup()
      const m = streaming(s)
      await m.start()
      await m.delta(0, reply.slice(0, i))
      await m.delta(0, reply.slice(i))
      await m.textEnd(0, reply)
      await m.end([text(reply)])
      await s.speech.sender.settled()
      expect(bridge.paths()).toEqual(expected)
    }
  })

  test("speaks wrapped lines whole, without heading marks, with list numbers as rendered", async () => {
    const reply = [
      "## Recommended fix",
      "",
      "Change the streaming chunker so that a single line end inside a",
      "paragraph is plain whitespace and never a reason to cut.",
      "",
      "1. Treat soft-wrapped line ends as spaces between words",
      "1. Keep paragraph breaks, headings and list items as cuts",
    ].join("\n")
    const s = setup()
    const m = streaming(s)
    await m.start()
    for (const piece of reply.match(/[\s\S]{1,3}/g)!) await m.delta(0, piece)
    await m.textEnd(0, reply)
    await m.end([text(reply)])
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([
      "/say Recommended fix\n\nChange the streaming chunker so that a single line end inside a\nparagraph is plain whitespace and never a reason to cut.",
      "/say 1. Treat soft-wrapped line ends as spaces between words",
      "/say 2. Keep paragraph breaks, headings and list items as cuts",
    ])
  })

  test("flushes each text block once, at text_end or else at message_end", async () => {
    const s = setup()
    const m = streaming(s)
    await m.start()
    await m.delta(0, "First block")
    await m.textEnd(0, "First block")
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual(["/say First block"])
    await m.delta(1, "Second block without text_end")
    await m.end([text("First block"), text("Second block without text_end"), text("Third block never streamed")])
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([
      "/say First block",
      "/say Second block without text_end",
      "/say Third block never streamed",
    ])
  })

  test("text_end supplies text whose deltas were missed", async () => {
    const s = setup()
    const m = streaming(s)
    await m.start()
    await m.delta(0, "Partial")
    await m.textEnd(0, "Partial and completed by text_end")
    await m.end([text("Partial and completed by text_end")])
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual(["/say Partial and completed by text_end"])
  })

  test("final text that disagrees with the deltas is not sent twice", async () => {
    const s = setup()
    const m = streaming(s)
    await m.start()
    await m.delta(0, "Streamed words")
    await m.end([text("Rewritten words")])
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual(["/say Streamed words"])
  })

  test("speaks commentary before a tool call, never thinking or tool calls", async () => {
    const s = setup()
    const m = streaming(s)
    await m.start()
    await m.thinking(0, "Secret thinking that must stay silent. ")
    await m.delta(1, "I will read the config file first.")
    await m.textEnd(1, "I will read the config file first.")
    await bridge.received(1)
    await m.toolCall(2, '{"path": "config.json. Not speech."}')
    await m.end(
      [
        { type: "thinking", thinking: "Secret thinking that must stay silent. " },
        text("I will read the config file first."),
        { type: "toolCall", name: "read" },
      ],
      "toolUse",
    )
    await s.emit("message_start", { message: { role: "toolResult", content: [] } })
    await s.emit("message_end", { message: { role: "toolResult", content: [text("tool output. Not speech.")] } })
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual(["/say I will read the config file first."])
  })

  test("text blocks are chunked separately", async () => {
    const s = setup()
    const m = streaming(s)
    await m.start()
    await m.delta(0, "Short intro")
    await m.delta(2, "Another short one")
    await m.textEnd(2, "Another short one")
    await m.textEnd(0, "Short intro")
    await m.end([text("Short intro"), { type: "toolCall", name: "x" }, text("Another short one")])
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual(["/say Another short one", "/say Short intro"])
  })

  test("aborted and failed messages drop their unsent tail", async () => {
    for (const stopReason of ["aborted", "error"]) {
      bridge.requests.splice(0)
      const s = setup()
      const m = streaming(s)
      await m.start()
      await m.delta(0, `${SENTENCE} An unfinished tail`)
      await m.end([text(`${SENTENCE} An unfinished tail`)], stopReason)
      await s.speech.sender.settled()
      expect(bridge.paths()).toEqual([`/say ${SENTENCE}`])
    }
  })

  test("stop during live output mutes the rest of the message only", async () => {
    const s = setup()
    const m = streaming(s)
    bridge.holdSay = true
    await m.start()
    await m.delta(0, `${SENTENCE} ${OTHER} Still`)
    await bridge.received(1)
    await s.commands.get(SPEECH_STOP_COMMAND)!("", s.ctx)
    await m.delta(0, " streaming after the stop. More text that is long enough to be sent.")
    await m.textEnd(0, "ignored")
    await m.end([text("ignored")])
    bridge.holdSay = false
    bridge.release()
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`, "/stop", "/stop"])
    await m.start()
    await m.delta(0, OTHER)
    await m.end([text(OTHER)])
    await s.speech.sender.settled()
    expect(bridge.paths().at(-1)).toBe(`/say ${OTHER}`)
  })

  test("an interrupt during live output stops at once and sends nothing more", async () => {
    const s = setup()
    const m = streaming(s)
    await s.emit("agent_start")
    await m.start()
    await m.delta(0, `${SENTENCE}\n\n`)
    await bridge.received(1)
    s.controller.abort()
    await bridge.received(2)
    await m.delta(0, `${OTHER}\n\n`)
    await m.end([text(`${SENTENCE}\n\n${OTHER}\n\n`)], "aborted")
    await s.emit("agent_settled", { aborted: true })
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`, "/stop", "/stop"])
  })

  test("switching speech off mid-message drops the rest of that message", async () => {
    const s = setup()
    const m = streaming(s)
    await m.start()
    await m.delta(0, `${SENTENCE}\n\n`)
    mode = "off"
    await m.delta(0, `${OTHER}\n\n`)
    await m.end([text(`${SENTENCE}\n\n${OTHER}\n\n`)])
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`])
  })

  test("a mode change takes effect with the next message, without repeats", async () => {
    const s = setup()
    const m = streaming(s)
    mode = "off"
    await m.start()
    mode = "live"
    await m.delta(0, `${SENTENCE} `)
    await settle()
    await m.end([text(`${SENTENCE} `)])
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([])
    await m.start()
    await m.delta(0, `${OTHER} `)
    await m.end([text(`${OTHER} `)])
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${OTHER}`])
  })

  test("a failed send drops the rest of that message and the next one retries", async () => {
    const s = setup()
    const m = streaming(s)
    bridge.sayStatus = 503
    await m.start()
    await m.delta(0, `${SENTENCE} `)
    await s.speech.sender.settled()
    await m.delta(0, `${OTHER} `)
    await m.end([text(`${SENTENCE} ${OTHER} `)])
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`])
    expect(s.notes.length).toBe(1)
    bridge.sayStatus = 202
    await m.start()
    await m.delta(0, OTHER)
    await m.end([text(OTHER)])
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`, `/say ${OTHER}`])
  })

  test("stays silent outside the TUI", async () => {
    for (const ctxMode of ["rpc", "json", "print"]) {
      const s = setup(ctxMode)
      const m = streaming(s)
      await m.start()
      await m.delta(0, `${SENTENCE} ${OTHER}`)
      await m.textEnd(0, `${SENTENCE} ${OTHER}`)
      await m.end([text(`${SENTENCE} ${OTHER}`)])
      await s.speech.sender.settled()
    }
    expect(bridge.paths()).toEqual([])
  })

  test("session shutdown mid-message stops and drops the rest", async () => {
    const s = setup()
    const m = streaming(s)
    await m.start()
    await m.delta(0, `${SENTENCE}\n\n`)
    await s.speech.sender.settled()
    await s.emit("session_shutdown", { reason: "quit" })
    await m.delta(0, `${OTHER}\n\n`)
    await m.end([text(`${SENTENCE}\n\n${OTHER}\n\n`)])
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`, "/stop"])
  })
})

describe("requested speech", () => {
  const idleCtx = (s: ReturnType<typeof setup>, idle = true, ctxMode = "tui") =>
    ({ ...s.ctx, mode: ctxMode, isIdle: () => idle }) as any

  test("speaks the given texts even with automatic speech off", async () => {
    mode = "off"
    const s = setup()
    expect(s.speech.request([SENTENCE, OTHER], idleCtx(s))).toBe("sent")
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`, `/say ${OTHER}`])
  })

  test("is refused while the agent runs or a message is live, leaving live speech alone", async () => {
    const s = setup()
    expect(s.speech.request([OTHER], idleCtx(s, false))).toBe("busy")
    const m = streaming(s)
    await m.start()
    await m.delta(0, `${SENTENCE} `)
    expect(s.speech.request([OTHER], idleCtx(s))).toBe("busy")
    await m.textEnd(0, SENTENCE)
    await m.end([text(SENTENCE)])
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([`/say ${SENTENCE}`])
  })

  test("reports outside the TUI and empty text without sending", async () => {
    const s = setup()
    expect(s.speech.request([SENTENCE], idleCtx(s, true, "rpc"))).toBe("unavailable")
    expect(s.speech.request(["", "  "], idleCtx(s))).toBe("empty")
    await s.speech.sender.settled()
    expect(bridge.paths()).toEqual([])
  })
})
