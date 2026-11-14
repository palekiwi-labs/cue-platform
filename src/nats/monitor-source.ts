import { DeliverPolicy, jetstream, type ConsumerMessages } from "@nats-io/jetstream"
import type { KvWatchEntry } from "@nats-io/kv"
import { connect, type NatsConnection, type QueuedIterator } from "@nats-io/transport-node"
import { resolveNatsUrl } from "./client"
import { EVENT_STREAM, EVENT_SUBJECT_ROOT, REGISTRY_BUCKET, resolveJsDomain, sessionEventsFilter, type AgentEvent, type RegistryRow } from "./events"
import { openRegistry } from "./jetstream"
import { ActivityLog, applyRegistryEntry, RunHistory } from "./monitor-model"

export interface MonitorSourceOptions {
  /** Server URL. Defaults to {@link resolveNatsUrl}. */
  url?: string
  /** JetStream domain. Defaults to {@link resolveJsDomain}; pass `null` for none. */
  domain?: string | null
  /** Timeout for the connection attempt, in milliseconds. */
  connectTimeoutMs?: number
  /** Activity items kept for the selected session. */
  maxActivity?: number
  /** Called whenever rows or the selected session's activity change. */
  onChange?: () => void
  /** Called when the live feed fails after opening. */
  onError?: (message: string) => void
}

/** Live view of the agent registry and the selected session's events. */
export interface MonitorSource {
  readonly url: string
  /** Current registry rows keyed by KV key. */
  rows(): RegistryRow[]
  /** True once the registry watch has delivered every existing row. */
  registryReady(): boolean
  /** Runs rebuilt from the event stream, kept live. */
  history(): RunHistory
  /** Sid whose events are being followed, if any. */
  selected(): string | undefined
  /** Recent activity of the selected session. */
  activity(): ActivityLog
  /** Follow `sid`'s events, replacing the previous selection. */
  select(sid: string | undefined): void
  close(): Promise<void>
}

const HISTORY_KINDS = ["start", "input", "error", "settled", "end"] as const
const READY_FALLBACK_MS = 3000

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Connect and start watching the registry. Rejects with a clear error when NATS is unreachable. */
export async function openMonitorSource(options: MonitorSourceOptions = {}): Promise<MonitorSource> {
  const url = options.url ?? resolveNatsUrl()
  const domain = options.domain === null ? undefined : (options.domain ?? resolveJsDomain())
  const onChange = options.onChange ?? (() => {})
  const onError = options.onError ?? (() => {})
  const maxActivity = options.maxActivity

  let nc: NatsConnection
  try {
    nc = await connect({ servers: url, timeout: options.connectTimeoutMs ?? 3000, name: "cue-agent-monitor" })
  } catch (err) {
    throw new Error(`cannot connect to NATS at ${url}: ${message(err)}`)
  }

  let watcher: QueuedIterator<KvWatchEntry>
  let ready = false
  try {
    const kv = await openRegistry(nc, domain)
    ready = (await kv.status()).values === 0
    watcher = await kv.watch()
  } catch (err) {
    await nc.close().catch(() => undefined)
    throw new Error(`cannot open registry bucket "${REGISTRY_BUCKET}" at ${url}: ${message(err)}`)
  }

  const js = jetstream(nc, domain ? { domain } : {})
  const rowMap = new Map<string, RegistryRow>()
  let closed = false
  let selectedSid: string | undefined
  let log = new ActivityLog(maxActivity)
  let messages: ConsumerMessages | undefined
  let generation = 0

  void (async () => {
    try {
      for await (const entry of watcher) {
        applyRegistryEntry(rowMap, { key: entry.key, operation: entry.operation, value: () => entry.string() })
        if (entry.delta === 0) ready = true
        onChange()
      }
    } catch (err) {
      if (!closed) onError(`registry watch failed: ${message(err)}`)
    }
  })()

  const readyTimer = setTimeout(() => {
    ready = true
    onChange()
  }, READY_FALLBACK_MS)
  readyTimer.unref?.()

  const history = new RunHistory()
  let historyFeed: ConsumerMessages | undefined
  void (async () => {
    try {
      const consumer = await js.consumers.get(EVENT_STREAM, {
        filter_subjects: HISTORY_KINDS.map((kind) => `${EVENT_SUBJECT_ROOT}.*.${kind}`),
        deliver_policy: DeliverPolicy.All,
      })
      historyFeed = await consumer.consume()
      if (closed) return void (await historyFeed.close().catch(() => undefined))
      for await (const m of historyFeed) {
        try {
          history.apply(m.json<AgentEvent>())
        } catch {
          continue
        }
        onChange()
      }
    } catch (err) {
      if (!closed) onError(`run history feed failed: ${message(err)}`)
    }
  })()

  async function stopConsumer(): Promise<void> {
    const current = messages
    messages = undefined
    if (current) await current.close().catch(() => undefined)
  }

  async function follow(sid: string, gen: number): Promise<void> {
    let iter: ConsumerMessages
    try {
      const consumer = await js.consumers.get(EVENT_STREAM, {
        filter_subjects: [sessionEventsFilter(sid)],
        deliver_policy: DeliverPolicy.All,
      })
      iter = await consumer.consume()
    } catch (err) {
      if (gen === generation && !closed) onError(`cannot follow events of ${sid}: ${message(err)}`)
      return
    }
    if (gen !== generation || closed) {
      await iter.close().catch(() => undefined)
      return
    }
    messages = iter
    try {
      for await (const m of iter) {
        if (gen !== generation) break
        try {
          log.add(m.json<AgentEvent>())
        } catch {
          continue
        }
        onChange()
      }
    } catch (err) {
      if (gen === generation && !closed) onError(`event feed of ${sid} failed: ${message(err)}`)
    }
  }

  return {
    url,
    rows: () => [...rowMap.values()],
    registryReady: () => ready,
    history: () => history,
    selected: () => selectedSid,
    activity: () => log,
    select(sid) {
      if (closed || sid === selectedSid) return
      selectedSid = sid
      const gen = ++generation
      log = new ActivityLog(maxActivity)
      onChange()
      void stopConsumer().then(() => {
        if (sid !== undefined && gen === generation && !closed) return follow(sid, gen)
      })
    },
    async close() {
      if (closed) return
      closed = true
      generation++
      clearTimeout(readyTimer)
      watcher.stop()
      await historyFeed?.close().catch(() => undefined)
      await stopConsumer()
      await nc.close().catch(() => undefined)
    },
  }
}
