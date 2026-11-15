import { request } from "node:http"

/** Overrides the bridge address, for tests and other hosts. */
export const SPEECH_URL_ENV = "CUE_SPEECH_URL"
export const DEFAULT_SPEECH_URL = "http://10.77.0.1:8881"
export const REQUEST_TIMEOUT_MS = 1500

export type PostResult = { ok: true } | { ok: false; reason: string }

/**
 * POST a body to the bridge over node:http, which ignores proxy settings
 * from the environment. Never rejects: failures and timeouts are results.
 */
export function post(baseUrl: string, path: string, body: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<PostResult> {
  return new Promise((resolve) => {
    let done = false
    const finish = (result: PostResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    let req: ReturnType<typeof request>
    try {
      req = request(new URL(path, baseUrl), {
        method: "POST",
        agent: false,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      })
    } catch (err) {
      resolve({ ok: false, reason: err instanceof Error ? err.message : String(err) })
      return
    }
    const timer = setTimeout(() => {
      finish({ ok: false, reason: `no answer within ${timeoutMs} ms` })
      req.destroy()
    }, timeoutMs)
    req.on("response", (res) => {
      res.resume()
      const status = res.statusCode ?? 0
      finish(status >= 200 && status < 300 ? { ok: true } : { ok: false, reason: `HTTP ${status}` })
    })
    req.on("error", (err) => finish({ ok: false, reason: err.message }))
    req.end(body)
  })
}

export interface SenderOptions {
  transport?: "nats" | "http"
  url?: string
  timeoutMs?: number
  /** Called when a /say fails; the rest of that message has been dropped. */
  onFailure?: (reason: string) => void
  /** Called when a /say was accepted. */
  onSuccess?: () => void
}

interface Item {
  message: number
  text: string
}

/**
 * Sends sentences to the speech bridge one request at a time, in order.
 * A stop drops everything pending and reaches the bridge at once; when a
 * sentence was in flight during the stop, a second stop follows it so the
 * bridge cannot keep a sentence it accepted after the first one.
 */
export class SpeechSender {
  private readonly url: string
  private readonly timeoutMs: number
  private pending: Item[] = []
  private messages = 0
  private failedMessage = 0
  private inFlight = false
  private stopAfterFlight = false
  private drainRun: Promise<void> | null = null
  private readonly stops = new Set<Promise<void>>()
  /** Whether this sender has sent anything to the bridge yet. */
  used = false

  constructor(private readonly options: SenderOptions = {}) {
    this.url = options.url ?? process.env[SPEECH_URL_ENV] ?? DEFAULT_SPEECH_URL
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  }

  /** A new message number, for sending one message in several parts. */
  newMessage(): number {
    return ++this.messages
  }

  /**
   * Queue chunks of a message behind everything already queued. Chunks of a
   * message whose earlier send failed are dropped.
   */
  say(sentences: string[], message = this.newMessage()): void {
    if (sentences.length === 0 || message === this.failedMessage) return
    for (const text of sentences) this.pending.push({ message, text })
    if (!this.drainRun) this.drainRun = this.drain().finally(() => (this.drainRun = null))
  }

  /** Drop pending sentences and silence the bridge. Resolves when the stop request settled. */
  stop(): Promise<void> {
    this.pending = []
    if (this.inFlight) this.stopAfterFlight = true
    return this.sendStop()
  }

  complete(_message: number): void {}

  async close(): Promise<void> {
    await this.settled()
  }

  /** Resolves once nothing is pending or in flight, including stops. */
  async settled(): Promise<void> {
    while (this.drainRun || this.stops.size > 0) await Promise.all([this.drainRun, ...this.stops])
  }

  private sendStop(): Promise<void> {
    this.used = true
    const stop = post(this.url, "/stop", "", this.timeoutMs).then(() => {})
    this.stops.add(stop)
    void stop.finally(() => this.stops.delete(stop))
    return stop
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.stops.size > 0) await Promise.all([...this.stops])
      const item = this.pending.shift()
      if (!item) return
      this.used = true
      this.inFlight = true
      const result = await post(this.url, "/say", JSON.stringify({ text: item.text }), this.timeoutMs)
      this.inFlight = false
      if (this.stopAfterFlight) {
        this.stopAfterFlight = false
        void this.sendStop()
      }
      if (result.ok) {
        this.options.onSuccess?.()
      } else {
        this.failedMessage = item.message
        this.pending = this.pending.filter((p) => p.message !== item.message)
        this.options.onFailure?.(result.reason)
      }
    }
  }
}
