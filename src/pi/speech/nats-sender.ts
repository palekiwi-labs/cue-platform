import { randomUUID } from "node:crypto"
import type { NatsConnection, Subscription } from "@nats-io/transport-node"
import { createNatsClient, type NatsClient } from "../../nats/client"
import type { SenderOptions } from "./sender"
import type { SpeechVoice } from "./settings"

export type SpeechPublisher = Pick<NatsClient, "start" | "publish" | "close">

/** Bridge progress for one utterance: a chunk starts, or the utterance ends. */
export interface SpeechProgress {
  type: "chunk" | "stopped" | "finished"
  utt: string
  seq?: number
  text?: string
}

/** The progress event a `speech.evt.*` message carries, or undefined. */
export function progressEvent(subject: string, body: unknown, utt?: string): SpeechProgress | undefined {
  if (!subject.startsWith("speech.evt.")) return undefined
  const type = subject.slice("speech.evt.".length)
  if (type !== "chunk" && type !== "stopped" && type !== "finished") return undefined
  if (typeof body !== "object" || body === null) return undefined
  const b = body as Record<string, unknown>
  if (typeof b.utt !== "string" || (utt !== undefined && b.utt !== utt)) return undefined
  return {
    type,
    utt: b.utt,
    ...(typeof b.seq === "number" ? { seq: b.seq } : {}),
    ...(typeof b.text === "string" ? { text: b.text } : {}),
  }
}

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
  private subscription: Subscription | undefined
  /** Called with bridge progress for the utterance currently being sent, when set. */
  onProgress: ((event: SpeechProgress) => void) | undefined
  used = false

  constructor(private readonly options: SenderOptions = {}, client?: SpeechPublisher) {
    this.client = client ?? createNatsClient({ name: "pi-speech", onConnect: (nc) => this.watch(nc) })
    this.client.start()
  }

  /** The utterance id of the message being sent, for matching progress events. */
  currentUtt(): string | undefined {
    return this.current?.utt
  }

  private watch(nc: NatsConnection): void {
    this.subscription?.unsubscribe()
    this.subscription = nc.subscribe("speech.evt.>", {
      callback: (_error, msg) => {
        let body: unknown
        try {
          body = msg.json()
        } catch {
          return
        }
        const event = progressEvent(msg.subject, body, this.current?.utt)
        if (event) this.onProgress?.(event)
      },
    })
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
    this.subscription?.unsubscribe()
    this.subscription = undefined
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
