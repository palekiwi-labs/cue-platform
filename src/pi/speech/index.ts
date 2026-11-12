import type { AgentSettledEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { splitSentences } from "./sentences"
import { SpeechSender, type SenderOptions } from "./sender"
import { type SpeechMode, speechMode } from "./settings"

/** Set in the turn summarizer's own pi, which must never speak. */
export const SUMMARIZER_ENV = "CUE_TURN_SUMMARIZER"
export const SPEECH_STOP_COMMAND = "speech-stop"
export const SPEECH_STOP_SHORTCUT = "alt+x"

type ModeContext = Pick<ExtensionContext, "mode">

interface SpokenMessage {
  role: string
  stopReason?: string
  content?: unknown
}

function messageText(message: SpokenMessage): string {
  if (!Array.isArray(message.content)) return ""
  return message.content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n\n")
}

export interface SpeechOptions extends Omit<SenderOptions, "onFailure" | "onSuccess"> {
  mode?: () => SpeechMode
}

/**
 * Speaks finished assistant messages of a TUI session through the host
 * speech bridge, and stops speech on request or when a run is interrupted.
 */
export class Speech {
  readonly sender: SpeechSender
  private readonly mode: () => SpeechMode
  private muted = false
  private warned = false
  private notifyCtx: Pick<ExtensionContext, "ui"> | undefined
  private detachAbort: (() => void) | null = null

  constructor(options: SpeechOptions = {}) {
    this.mode = options.mode ?? (() => speechMode())
    this.sender = new SpeechSender({
      ...options,
      onFailure: (reason) => this.failed(reason),
      onSuccess: () => (this.warned = false),
    })
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
    if (this.speaks(ctx)) await this.stop()
  }

  messageStart(message: SpokenMessage): void {
    if (message.role === "assistant") this.muted = false
  }

  messageEnd(message: SpokenMessage, ctx: ModeContext & Pick<ExtensionContext, "ui">): void {
    try {
      if (ctx.mode !== "tui" || message.role !== "assistant" || this.muted) return
      if (message.stopReason === "aborted" || message.stopReason === "error") return
      if (this.mode() === "off") return
      this.notifyCtx = ctx
      this.sender.say(splitSentences(messageText(message)))
    } catch {}
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

/** Spoken replies in TUI sessions, with /speech-stop and a stop key. */
export function registerSpeech(pi: ExtensionAPI, options: SpeechOptions = {}): Speech | undefined {
  if (process.env[SUMMARIZER_ENV]) return undefined
  const speech = new Speech(options)
  pi.on("agent_start", (_event, ctx) => speech.agentStart(ctx))
  pi.on("agent_end", () => speech.runEnd())
  pi.on("agent_settled", (event, ctx) => speech.settled(event, ctx))
  pi.on("message_start", (event) => speech.messageStart(event.message))
  pi.on("message_end", (event, ctx) => speech.messageEnd(event.message, ctx))
  pi.on("session_shutdown", (_event, ctx) => speech.shutdown(ctx))
  pi.registerCommand(SPEECH_STOP_COMMAND, {
    description: "Stop spoken replies and drop what is queued",
    handler: async () => speech.stop(),
  })
  pi.registerShortcut(SPEECH_STOP_SHORTCUT, {
    description: "Stop spoken replies",
    handler: () => {
      void speech.stop()
    },
  })
  return speech
}
