import type { AgentSettledEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { SpokenChunker } from "./chunks"
import { SpeechSender, type SenderOptions } from "./sender"
import { NatsSpeechSender, speechTransport, type SpeechPublisher } from "./nats-sender"
import { SessionSpeechMode, SessionSpeechVoice, type SpeechMode, type SpeechVoice } from "./settings"

/** Set in the turn summarizer's own pi, which must never speak. */
export const SUMMARIZER_ENV = "CUE_TURN_SUMMARIZER"
export const SPEECH_STOP_COMMAND = "speech-stop"
export const SPEECH_STOP_SHORTCUT = "alt+x"

type ModeContext = Pick<ExtensionContext, "mode">
type MessageContext = ModeContext & Pick<ExtensionContext, "ui">

interface SpokenMessage {
  role: string
  stopReason?: string
  content?: unknown
}

interface StreamEvent {
  type: string
  contentIndex?: number
  delta?: string
  content?: unknown
}

interface LiveBlock {
  chunker: SpokenChunker
  fed: string
  done: boolean
}

interface CurrentMessage {
  id: number
  mode: SpeechMode
  blocks: Map<number, LiveBlock>
}

function textBlocks(message: SpokenMessage): { index: number; text: string }[] {
  if (!Array.isArray(message.content)) return []
  return message.content.flatMap((part: { type?: unknown; text?: unknown } | null, index) =>
    part?.type === "text" && typeof part.text === "string" ? [{ index, text: part.text }] : [],
  )
}

export interface SpeechOptions extends Omit<SenderOptions, "onFailure" | "onSuccess"> {
  mode?: () => SpeechMode
  voice?: () => SpeechVoice
  publisher?: SpeechPublisher
}

/**
 * Speaks the assistant messages of a TUI session through the host speech
 * bridge, chunk by chunk while they stream,
 * and stops speech on request or when a run is interrupted.
 */
export class Speech {
  readonly sender: SpeechSender | NatsSpeechSender
  readonly setting: SessionSpeechMode | undefined
  readonly voiceSetting: SessionSpeechVoice | undefined
  private readonly mode: () => SpeechMode
  private readonly voice: () => SpeechVoice | undefined
  private muted = false
  private warned = false
  private current: CurrentMessage | null = null
  private notifyCtx: Pick<ExtensionContext, "ui"> | undefined
  private detachAbort: (() => void) | null = null

  constructor(options: SpeechOptions = {}, setting?: SessionSpeechMode, voiceSetting?: SessionSpeechVoice) {
    this.setting = setting
    this.voiceSetting = voiceSetting
    this.mode = options.mode ?? (() => setting?.mode ?? "off")
    this.voice = options.voice ?? (() => voiceSetting?.voice)
    const senderOptions = {
      ...options,
      onFailure: (reason: string) => this.failed(reason),
      onSuccess: () => (this.warned = false),
    }
    this.sender = speechTransport(options) === "nats"
      ? new NatsSpeechSender(senderOptions, options.publisher)
      : new SpeechSender(senderOptions)
  }

  /** Silence the bridge and mute the rest of the current assistant message. */
  stop(): Promise<void> {
    this.muted = true
    return this.sender.stop()
  }

  agentStart(ctx: ModeContext & Pick<ExtensionContext, "signal">): void {
    this.runEnd()
    const signal = ctx.signal
    if (!signal) return
    if (signal.aborted) {
      this.interrupt(ctx)
      return
    }
    const onAbort = () => this.interrupt(ctx)
    signal.addEventListener("abort", onAbort, { once: true })
    this.detachAbort = () => signal.removeEventListener("abort", onAbort)
  }

  runEnd(): void {
    this.detachAbort?.()
    this.detachAbort = null
  }

  settled(event: Pick<AgentSettledEvent, "aborted">, ctx: ModeContext): void {
    this.runEnd()
    if (event.aborted) this.interrupt(ctx)
  }

  async shutdown(ctx: ModeContext): Promise<void> {
    this.runEnd()
    this.current = null
    try {
      if (this.speaks(ctx)) await this.stop()
    } finally {
      await this.sender.close()
    }
  }

  /** An assistant message starts: unmute, and fix its speech mode for the whole message. */
  messageStart(message: SpokenMessage, ctx: MessageContext): void {
    if (message.role !== "assistant") return
    this.muted = false
    this.current = null
    try {
      this.current = this.newMessage(ctx)
    } catch {}
  }

  /** Live mode: feed streamed text and send the chunks it completes. */
  messageUpdate(message: SpokenMessage, event: StreamEvent, ctx: MessageContext): void {
    try {
      const current = this.current
      if (!current || current.mode !== "live" || this.muted) return
      if (ctx.mode !== "tui" || message.role !== "assistant" || typeof event.contentIndex !== "number") return
      if (event.type === "text_delta" && typeof event.delta === "string") {
        this.feed(current, event.contentIndex, event.delta)
      } else if (event.type === "text_end") {
        this.endBlock(current, event.contentIndex, event.content)
      }
    } catch {}
  }

  /**
   * An assistant message ends: live mode flushes every text block not
   * flushed yet. Aborted and failed messages send nothing more.
   */
  messageEnd(message: SpokenMessage, ctx: MessageContext): void {
    if (message.role !== "assistant") return
    const started = this.current
    this.current = null
    try {
      if (ctx.mode !== "tui" || this.muted) return
      if (message.stopReason === "aborted" || message.stopReason === "error") {
        if (this.sender instanceof NatsSpeechSender && this.sender.used) void this.sender.stop()
        return
      }
      const current = started ?? this.newMessage(ctx)
      if (current.mode !== "live") return
      for (const { index, text } of textBlocks(message)) this.endBlock(current, index, text)
      this.sender.complete(current.id)
    } catch {}
  }

  private newMessage(ctx: MessageContext): CurrentMessage {
    const mode = ctx.mode === "tui" ? this.mode() : "off"
    if (mode !== "off") this.notifyCtx = ctx
    return { id: this.sender.newMessage(this.voice()), mode, blocks: new Map() }
  }

  private block(current: CurrentMessage, index: number): LiveBlock {
    let block = current.blocks.get(index)
    if (!block) {
      block = { chunker: new SpokenChunker(), fed: "", done: false }
      current.blocks.set(index, block)
    }
    return block
  }

  private feed(current: CurrentMessage, index: number, text: string): void {
    const block = this.block(current, index)
    if (block.done) return
    block.fed += text
    this.send(current, block.chunker.push(text))
  }

  private endBlock(current: CurrentMessage, index: number, content: unknown): void {
    const block = this.block(current, index)
    if (block.done) return
    if (typeof content === "string" && content.startsWith(block.fed)) {
      this.feed(current, index, content.slice(block.fed.length))
    }
    block.done = true
    this.send(current, block.chunker.flush())
  }

  private send(current: CurrentMessage, chunks: string[]): void {
    if (chunks.length === 0 || this.muted) return
    if (this.mode() === "off") {
      this.muted = true
      this.sender.complete(current.id)
      return
    }
    this.sender.say(chunks, current.id)
  }

  private speaks(ctx: ModeContext): boolean {
    return ctx.mode === "tui" && (this.sender.used || this.mode() !== "off")
  }

  private interrupt(ctx: ModeContext): void {
    this.muted = true
    try {
      if (this.speaks(ctx)) void this.sender.stop()
    } catch {}
  }

  private failed(reason: string): void {
    if (this.warned) return
    this.warned = true
    try {
      this.notifyCtx?.ui.notify(`Speech bridge unavailable (${reason}); speech resumes with the next message.`, "warning")
    } catch {}
  }
}

/**
 * Spoken replies in TUI sessions, with /speech-stop and a stop key. The
 * speech mode belongs to the session: restored from it at session start,
 * off for a session that never set it.
 */
export function registerSpeech(pi: ExtensionAPI, options: SpeechOptions = {}): Speech | undefined {
  if (process.env[SUMMARIZER_ENV]) return undefined
  const setting = new SessionSpeechMode(pi)
  const voiceSetting = new SessionSpeechVoice(pi)
  const speech = new Speech(options, setting, voiceSetting)
  pi.on("session_start", (_event, ctx) => {
    setting.restore(ctx)
    voiceSetting.restore(ctx)
  })
  pi.on("agent_start", (_event, ctx) => speech.agentStart(ctx))
  pi.on("agent_end", () => speech.runEnd())
  pi.on("agent_settled", (event, ctx) => speech.settled(event, ctx))
  pi.on("message_start", (event, ctx) => speech.messageStart(event.message, ctx))
  pi.on("message_update", (event, ctx) => speech.messageUpdate(event.message, event.assistantMessageEvent, ctx))
  pi.on("message_end", (event, ctx) => speech.messageEnd(event.message, ctx))
  pi.on("session_shutdown", (_event, ctx) => speech.shutdown(ctx))
  pi.registerCommand(SPEECH_STOP_COMMAND, {
    description: "Stop global speech and drop this message's remaining speech",
    handler: async () => speech.stop(),
  })
  pi.registerShortcut(SPEECH_STOP_SHORTCUT, {
    description: "Stop global speech",
    handler: () => {
      void speech.stop()
    },
  })
  return speech
}
