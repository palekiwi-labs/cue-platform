import { connect, type NatsConnection } from "@nats-io/transport-node"

export const DEFAULT_NATS_URL = "nats://127.0.0.1:4222"
export const NATS_URL_ENV = "CUE_NATS_URL"

/**
 * Connection state of a {@link NatsClient}.
 *
 * - `idle`: never started; nothing has touched the network.
 * - `connecting`: started but not yet connected (including backoff
 *   between failed initial attempts).
 * - `connected`: messages are being published.
 * - `reconnecting`: a live connection was lost and is being restored.
 * - `closed`: `close()` was called; the client is inert.
 */
export type NatsClientState = "idle" | "connecting" | "connected" | "reconnecting" | "closed"

export interface NatsClientOptions {
  /** Server URL. Defaults to `$CUE_NATS_URL`, then {@link DEFAULT_NATS_URL}. */
  url?: string
  /** Connection name reported to the server. */
  name?: string
  /** Timeout for a single connection attempt, in milliseconds. */
  connectTimeoutMs?: number
  /** Wait between reconnect attempts after a live connection drops. */
  reconnectTimeWaitMs?: number
  /** First delay before retrying a failed initial connection. */
  retryInitialMs?: number
  /** Upper bound of the exponential backoff for initial connection retries. */
  retryMaxMs?: number
  /** Timeout for draining on `close()`, after which the connection is closed. */
  drainTimeoutMs?: number
}

/**
 * Fire-and-forget NATS publisher. It never blocks or throws into the
 * caller: messages published while not connected are dropped and counted.
 */
export interface NatsClient {
  /** Start connecting in the background. Idempotent; `publish` calls it too. */
  start(): void
  /**
   * Publish `data` on `subject`. Strings and byte arrays are sent as-is,
   * anything else is JSON-encoded. Returns synchronously and never throws;
   * returns false when the message was dropped.
   */
  publish(subject: string, data?: unknown): boolean
  /** Current connection state. */
  state(): NatsClientState
  /** True when publishing reaches the server. */
  isConnected(): boolean
  /** Number of messages dropped since creation. */
  dropped(): number
  /** Server URL the client targets. */
  url(): string
  /** Drain and close. Safe to call at any time, including never started. */
  close(): Promise<void>
}

export function resolveNatsUrl(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[NATS_URL_ENV]?.trim()
  return fromEnv ? fromEnv : DEFAULT_NATS_URL
}

const MAX_DROPPED = Number.MAX_SAFE_INTEGER

function encode(data: unknown): string | Uint8Array {
  if (typeof data === "string" || data instanceof Uint8Array) return data
  if (data === undefined) return ""
  return JSON.stringify(data) ?? ""
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** Create a lazily connecting, fire-and-forget NATS client. */
export function createNatsClient(options: NatsClientOptions = {}): NatsClient {
  const serverUrl = options.url ?? resolveNatsUrl()
  const connectTimeoutMs = options.connectTimeoutMs ?? 2000
  const reconnectTimeWaitMs = options.reconnectTimeWaitMs ?? 2000
  const retryInitialMs = options.retryInitialMs ?? 1000
  const retryMaxMs = options.retryMaxMs ?? 30000
  const drainTimeoutMs = options.drainTimeoutMs ?? 2000

  let current: NatsClientState = "idle"
  let nc: NatsConnection | null = null
  let droppedCount = 0
  let retryDelay = retryInitialMs
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let attempt: Promise<void> | null = null

  function drop(): false {
    if (droppedCount < MAX_DROPPED) droppedCount++
    return false
  }

  function scheduleRetry(): void {
    if (current === "closed" || retryTimer) return
    const wait = retryDelay
    retryDelay = Math.min(retryDelay * 2, retryMaxMs)
    retryTimer = setTimeout(() => {
      retryTimer = null
      attempt = tryConnect()
    }, wait)
    retryTimer.unref?.()
  }

  async function watch(conn: NatsConnection): Promise<void> {
    try {
      for await (const s of conn.status()) {
        if (nc !== conn || current === "closed") continue
        if (s.type === "disconnect") current = "reconnecting"
        else if (s.type === "reconnect") current = "connected"
      }
    } catch {
      return
    }
  }

  function onClosed(conn: NatsConnection): void {
    if (nc !== conn) return
    nc = null
    if (current === "closed") return
    current = "connecting"
    retryDelay = retryInitialMs
    scheduleRetry()
  }

  async function tryConnect(): Promise<void> {
    let conn: NatsConnection
    try {
      conn = await connect({
        servers: serverUrl,
        name: options.name,
        timeout: connectTimeoutMs,
        reconnect: true,
        maxReconnectAttempts: -1,
        reconnectTimeWait: reconnectTimeWaitMs,
      })
    } catch {
      scheduleRetry()
      return
    }
    if (current === "closed") {
      await conn.close().catch(() => undefined)
      return
    }
    nc = conn
    current = "connected"
    retryDelay = retryInitialMs
    void watch(conn)
    conn.closed().then(
      () => onClosed(conn),
      () => onClosed(conn),
    )
  }

  function start(): void {
    if (current !== "idle") return
    current = "connecting"
    attempt = tryConnect()
  }

  function publish(subject: string, data?: unknown): boolean {
    if (current === "idle") start()
    const conn = nc
    if (current !== "connected" || !conn) return drop()
    try {
      conn.publish(subject, encode(data))
      return true
    } catch {
      return drop()
    }
  }

  async function close(): Promise<void> {
    if (current === "closed") return
    const wasConnected = current === "connected"
    current = "closed"
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    await attempt
    const conn = nc
    nc = null
    if (!conn || conn.isClosed()) return
    if (wasConnected) {
      await Promise.race([conn.drain().catch(() => undefined), sleep(drainTimeoutMs)])
    }
    if (!conn.isClosed()) await conn.close().catch(() => undefined)
  }

  return {
    start,
    publish,
    state: () => current,
    isConnected: () => current === "connected",
    dropped: () => droppedCount,
    url: () => serverUrl,
    close,
  }
}
