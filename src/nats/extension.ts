import { hostname } from "node:os"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { currentContext } from "../pi/lib/current-context"
import { createNatsClient, type NatsClient } from "./client"
import {
  encodeEvent,
  eventSubject,
  messageError,
  registrySubject,
  resolveJsDomain,
  runIdOf,
  SessionTracker,
  type AgentEvent,
  type AgentIdentity,
} from "./events"
import { ensureInfra } from "./jetstream"

export const HEARTBEAT_MS = 30_000
export const TELEMETRY_DISABLE_ENV = "CUE_NATS_DISABLE"
const PENDING_LIMIT = 200

export interface NatsTelemetryOptions {
  client?: NatsClient
  url?: string
  host?: string
  now?: () => number
  heartbeatMs?: number
  env?: NodeJS.ProcessEnv
}

function contextAddress(ctx: ExtensionContext, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const fromBranch = currentContext(ctx.sessionManager.getBranch() as never)
    if (fromBranch) return fromBranch
  } catch {}
  return env.CUE_CONTEXT?.trim() || undefined
}

function identity(ctx: ExtensionContext, host: string, env: NodeJS.ProcessEnv): AgentIdentity {
  const sid = ctx.sessionManager.getSessionId()
  return {
    sid,
    host,
    mode: ctx.mode,
    cwd: ctx.cwd,
    session_file: ctx.sessionManager.getSessionFile(),
    session_name: ctx.sessionManager.getSessionName(),
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    context: contextAddress(ctx, env),
    run_id: runIdOf(sid),
    pid: process.pid,
  }
}

/**
 * Publish pi lifecycle and turn events on `agent.evt.<sid>.<kind>` and keep
 * the session's row in the `agents` KV bucket. Every write is
 * fire-and-forget: nothing here awaits the network on the harness path.
 */
export function registerNatsTelemetry(pi: ExtensionAPI, options: NatsTelemetryOptions = {}): void {
  const env = options.env ?? process.env
  if (env[TELEMETRY_DISABLE_ENV]) return
  const host = options.host ?? hostname()
  const now = options.now ?? Date.now
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
  const domain = resolveJsDomain(env)

  let client: NatsClient | undefined = options.client
  let tracker: SessionTracker | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let everConnected = false
  const pending: { subject: string; data: string; headers?: Record<string, string> }[] = []

  function send(subject: string, data: string, headers?: Record<string, string>): void {
    const c = getClient()
    if (c.publish(subject, data, headers) || everConnected) return
    if (pending.length < PENDING_LIMIT) pending.push({ subject, data, headers })
  }

  function flushPending(): void {
    everConnected = true
    const c = getClient()
    for (const m of pending.splice(0)) c.publish(m.subject, m.data, m.headers)
  }

  function getClient(): NatsClient {
    if (!client) {
      client = createNatsClient({
        url: options.url,
        name: `pi ${host} ${process.pid}`,
        onConnect: async (nc) => {
          try {
            await ensureInfra(nc, domain)
          } finally {
            flushPending()
            if (tracker) putRow(tracker)
          }
        },
      })
    }
    return client
  }

  function emit(t: SessionTracker, event: AgentEvent | undefined): void {
    if (!event) return
    send(eventSubject(t.sid, event.kind), encodeEvent(event), { "Nats-Msg-Id": t.msgId(event) })
  }

  function putRow(t: SessionTracker): void {
    send(registrySubject(t.sid, domain), JSON.stringify(t.row))
  }

  function emitAndPut(event: AgentEvent | undefined): void {
    if (!tracker) return
    emit(tracker, event)
    putRow(tracker)
  }

  function stopHeartbeat(): void {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = undefined
  }

  pi.on("session_start", (event, ctx) => {
    tracker = new SessionTracker(identity(ctx, host, env), now)
    emitAndPut(tracker.start(event.reason))
    stopHeartbeat()
    heartbeat = setInterval(() => {
      if (!tracker) return
      tracker.touch()
      putRow(tracker)
    }, heartbeatMs)
    heartbeat.unref?.()
  })

  pi.on("before_agent_start", (event, ctx) => {
    if (!tracker) return
    tracker.update({ model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, context: contextAddress(ctx, env) })
    if (event.messageType === "user") emitAndPut(tracker.input(event.prompt, "user"))
    else emitAndPut(tracker.input(event.message.customType ?? "custom", "custom"))
  })

  pi.on("turn_start", (event) => {
    if (tracker) emitAndPut(tracker.turnStart(event.turnIndex))
  })

  pi.on("message_update", (event) => {
    if (!tracker) return
    if (event.assistantMessageEvent?.type === "thinking_start") emit(tracker, tracker.thinking())
  })

  pi.on("turn_end", (event) => {
    if (!tracker) return
    emit(tracker, tracker.turnEnd(event.turnIndex, event.message))
    const error = messageError(event.message)
    if (error) emit(tracker, tracker.error(error))
    putRow(tracker)
  })

  pi.on("tool_execution_start", (event) => {
    if (tracker) emitAndPut(tracker.toolStart(event.toolCallId, event.toolName, event.args))
  })

  pi.on("tool_execution_end", (event) => {
    if (tracker) emit(tracker, tracker.toolEnd(event.toolCallId, event.toolName, event.isError, event.durationMs))
  })

  pi.on("agent_settled", (event) => {
    if (tracker) emitAndPut(tracker.settled(event.aborted))
  })

  pi.on("session_compact", (event) => {
    if (tracker) emit(tracker, tracker.compact(event.reason))
  })

  pi.on("session_info_changed", (event) => {
    if (!tracker) return
    tracker.update({ session_name: event.name })
    putRow(tracker)
  })

  pi.on("session_shutdown", async (event) => {
    stopHeartbeat()
    const t = tracker
    tracker = undefined
    const c = client
    if (t && c) {
      emit(t, t.end(event.reason))
      c.publish(registrySubject(t.sid, domain), "", { "KV-Operation": "DEL" })
    }
    if (c && !options.client) {
      client = undefined
      await c.close()
    }
  })
}
