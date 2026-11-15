import { describe, expect, test } from "bun:test"
import { NatsSpeechSender, speechTransport, type SpeechPublisher } from "./nats-sender"
import { registerSpeech, SPEECH_STOP_COMMAND, SPEECH_STOP_SHORTCUT } from "./index"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { connect } from "@nats-io/transport-node"
import { createNatsClient } from "../../nats/client"
import { natsServerBin, startJetStreamServer, waitFor } from "../../nats/test-server"

function fixture() {
  const publications: { subject: string; body: any }[] = []
  let connected = true
  let starts = 0
  let closes = 0
  const client: SpeechPublisher = {
    start() { starts++ },
    publish(subject, body) {
      if (!connected) return false
      publications.push({ subject, body })
      return true
    },
    async close() { closes++ },
  }
  const failures: string[] = []
  const sender = new NatsSpeechSender({ onFailure: (reason) => failures.push(reason) }, client)
  return { client, sender, publications, failures, disconnect: () => { connected = false },
    reconnect: () => { connected = true }, starts: () => starts, closes: () => closes }
}

test.skipIf(!natsServerBin)("speech reaches a core subscriber in order without request ACKs", async () => {
  const server = await startJetStreamServer()
  const nc = await connect({ servers: server.url })
  const client = createNatsClient({ url: server.url })
  const sender = new NatsSpeechSender({}, client)
  try {
    const received: { subject: string; body: any }[] = []
    nc.subscribe("speech.intent.*", {
      callback: (_err, msg) => { received.push({ subject: msg.subject, body: msg.json() }) },
    })
    await nc.flush()
    await waitFor(() => client.isConnected())
    sender.say(["Whole message replay or summary."])
    await sender.stop()
    await waitFor(() => received.length === 3)
    expect(received.map((p) => p.subject)).toEqual(["speech.intent.say", "speech.intent.say", "speech.intent.stop"])
    expect(received[0]!.body.seq).toBe(0)
    expect(received[1]!.body).toMatchObject({ seq: 1, final: true, text: "", utt: received[0]!.body.utt })
  } finally {
    await sender.close()
    await nc.close()
    await server.stop()
  }
})

describe("NATS speech", () => {
  test("defaults to NATS; HTTP requires explicit selection", () => {
    const old = process.env.CUE_SPEECH_TRANSPORT
    delete process.env.CUE_SPEECH_TRANSPORT
    try {
      expect(speechTransport()).toBe("nats")
      expect(speechTransport({ url: "http://test" })).toBe("http")
      expect(speechTransport({ url: "http://test", transport: "nats" })).toBe("nats")
      process.env.CUE_SPEECH_TRANSPORT = "http"
      expect(speechTransport()).toBe("http")
    } finally {
      if (old === undefined) delete process.env.CUE_SPEECH_TRANSPORT
      else process.env.CUE_SPEECH_TRANSPORT = old
    }
  })

  test("streams one utterance with contiguous seq and an empty final", async () => {
    const f = fixture()
    const id = f.sender.newMessage()
    f.sender.say(["First."], id)
    f.sender.say(["Second."], id)
    f.sender.complete(id)
    f.sender.complete(id)
    f.sender.say(["Late."], id)
    const bodies = f.publications.map((p) => p.body)
    expect(bodies.map((b) => [b.seq, b.final, b.text])).toEqual([
      [0, false, "First."], [1, false, "Second."], [2, true, ""],
    ])
    expect(new Set(bodies.map((b) => b.utt)).size).toBe(1)
    expect(bodies.every((b) => b.origin === "pi")).toBe(true)
    f.sender.say(["Replacement."])
    expect(f.publications[3]!.body.utt).not.toBe(bodies[0].utt)
    expect(f.publications[3]!.body.seq).toBe(0)
    await f.sender.close()
    expect(f.starts()).toBe(1)
    expect(f.closes()).toBe(1)
  })

  test("stop is global even before speech and drops late chunks without a delayed stop", async () => {
    const f = fixture()
    await f.sender.stop()
    const id = f.sender.newMessage()
    f.sender.say(["Playing."], id)
    await f.sender.stop()
    f.sender.say(["Late."], id)
    f.sender.complete(id)
    expect(f.publications.map((p) => p.subject)).toEqual([
      "speech.intent.stop", "speech.intent.say", "speech.intent.stop",
    ])
  })

  test("disconnected chunks poison the utterance; reconnect never replays it", () => {
    const f = fixture()
    const id = f.sender.newMessage()
    f.sender.say(["Before."], id)
    f.disconnect()
    f.sender.say(["Lost."], id)
    f.reconnect()
    f.sender.say(["After."], id)
    f.sender.complete(id)
    expect(f.publications).toHaveLength(1)
    expect(f.failures).toHaveLength(1)
    f.sender.say(["Fresh."])
    expect(f.publications[1]!.body.seq).toBe(0)
    expect(f.publications[1]!.body.utt).not.toBe(f.publications[0]!.body.utt)
  })

  test("bounds Unicode and JSON-escaped text to the host limits", () => {
    const f = fixture()
    const text = "😀".repeat(2500) + "\u0000".repeat(1100)
    f.sender.say([text])
    const bodies = f.publications.map((p) => p.body)
    expect(bodies.map((b) => b.text).join("")).toBe(text)
    expect(bodies.every((b) => Array.from(b.text).length <= 1000)).toBe(true)
    expect(bodies.every((b) => Buffer.byteLength(JSON.stringify(b)) <= 8192)).toBe(true)
    expect(bodies.map((b) => b.seq)).toEqual(bodies.map((_, i) => i))
  })

  test("extension streams, completes, aborts and globally stops while mode is off", async () => {
    const f = fixture()
    const handlers = new Map<string, Function>()
    const commands = new Map<string, Function>()
    const shortcuts = new Map<string, Function>()
    const pi = {
      on: (name: string, fn: Function) => handlers.set(name, fn),
      registerCommand: (name: string, o: any) => commands.set(name, o.handler),
      registerShortcut: (name: string, o: any) => shortcuts.set(name, o.handler),
    } as unknown as ExtensionAPI
    let mode: "off" | "live" = "off"
    const speech = registerSpeech(pi, { transport: "nats", publisher: f.client, mode: () => mode })!
    await commands.get(SPEECH_STOP_COMMAND)!()
    shortcuts.get(SPEECH_STOP_SHORTCUT)!()
    expect(f.publications.map((p) => p.subject)).toEqual(["speech.intent.stop", "speech.intent.stop"])
    mode = "live"
    const controller = new AbortController()
    const ctx = { mode: "tui", signal: controller.signal, ui: { notify() {} } }
    const text = "This is a sentence long enough to be spoken while streaming."
    const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }
    speech.agentStart(ctx as any)
    speech.messageStart(message, ctx as any)
    speech.messageUpdate(message, { type: "text_delta", contentIndex: 0, delta: text + " " }, ctx as any)
    expect(f.publications.at(-1)!.subject).toBe("speech.intent.say")
    expect(f.publications.at(-1)!.body.final).toBe(false)
    speech.messageEnd(message, ctx as any)
    const says = f.publications.filter((p) => p.subject === "speech.intent.say")
    expect(says.map((p) => p.body.text).join("")).toBe(text)
    expect(says.at(-1)!.body.final).toBe(true)
    speech.messageStart(message, ctx as any)
    speech.messageUpdate(message, { type: "text_delta", contentIndex: 0, delta: text }, ctx as any)
    controller.abort()
    const count = f.publications.length
    speech.messageEnd(message, ctx as any)
    expect(f.publications).toHaveLength(count)
    expect(f.publications.at(-1)!.subject).toBe("speech.intent.stop")
    await speech.shutdown(ctx as any)
    expect(f.closes()).toBe(1)
  })
})
