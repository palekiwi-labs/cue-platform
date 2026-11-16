import { randomUUID } from "node:crypto"
import { createNatsClient, type NatsClient } from "../../nats/client"
import type { SenderOptions } from "./sender"
import type { SpeechVoice } from "./settings"

export type SpeechPublisher = Pick<NatsClient, "start" | "publish" | "close">

interface Utterance {
  message: number
  utt: string
  voice: SpeechVoice | undefined
  seq: number
  sent: boolean
  closed: boolean
}

/** Live core speech publisher; disconnected utterances are discarded, never replayed. */
export class NatsSpeechSender {
  private readonly client: SpeechPublisher
  private current: Utterance | undefined
  private messages = 0
  used = false

  constructor(private readonly options: SenderOptions = {}, client?: SpeechPublisher) {
    this.client = client ?? createNatsClient({ name: "pi-speech" })
    this.client.start()
  }

  /** A new utterance; every chunk of it, the final one included, carries the given voice. */
  newMessage(voice?: SpeechVoice): number {
    if (this.current) this.complete(this.current.message)
    const message = ++this.messages
    this.current = { message, utt: randomUUID(), voice, seq: 0, sent: false, closed: false }
    return message
  }

  say(sentences: string[], message?: number): void {
    const standalone = message === undefined
    message ??= this.newMessage()
    const current = this.current
    if (!current || current.message !== message || current.closed) return
    for (const sentence of sentences) {
      const chars = Array.from(sentence)
      for (let start = 0; start < chars.length; start += 1000) {
        const text = chars.slice(start, start + 1000).join("")
        if (!text.trim()) continue
        if (!this.send(current, text, false)) return
      }
    }
    if (standalone) this.complete(message)
  }

  complete(message: number): void {
    const current = this.current
    if (!current || current.message !== message || current.closed) return
    if (current.sent) this.send(current, "", true)
    current.closed = true
  }

  stop(): Promise<void> {
    if (this.current) this.current.closed = true
    this.used = true
    if (!this.client.publish("speech.intent.stop", { origin: "pi" })) {
      this.options.onFailure?.("NATS disconnected; stop dropped")
    }
    return Promise.resolve()
  }

  settled(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    if (this.current) this.complete(this.current.message)
    return this.client.close()
  }

  private send(current: Utterance, text: string, final: boolean): boolean {
    this.used = true
    const body = {
      utt: current.utt,
      seq: current.seq,
      final,
      text,
      origin: "pi",
      ...(current.voice ? { voice: current.voice } : {}),
    }
    if (Buffer.byteLength(JSON.stringify(body)) > 8192 || !this.client.publish("speech.intent.say", body)) {
      current.closed = true
      this.options.onFailure?.("NATS unavailable; utterance dropped")
      return false
    }
    current.seq++
    current.sent = true
    this.options.onSuccess?.()
    return true
  }
}

export function speechTransport(options: SenderOptions = {}): "http" | "nats" {
  return options.transport ?? (options.url ? "http" : process.env.CUE_SPEECH_TRANSPORT === "http" ? "http" : "nats")
}
