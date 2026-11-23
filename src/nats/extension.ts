import { readFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { currentContext } from "../pi/lib/current-context"
import { currentTask } from "../pi/lib/session-task"
import { createNatsClient, type NatsClient } from "./client"
import {
  agentNameOf,
  contextTitleOf,
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
  tmuxNames?: () => Promise<TmuxNames>
}

/** Names of the tmux window and session holding an interactive pi. */
export interface TmuxNames {
  window?: string
  session?: string
}

export const TMUX_TIMEOUT_MS = 1_000

/**
 * Read the tmux window and session names of this pane, as `#W` and `#S`
 * show them. Only an interactive pi owning the pane's tty reports names:
 * child pi processes inherit TMUX_PANE from the window that launched them.
 */
export async function readTmuxNames(
  pi: ExtensionAPI,
  env: NodeJS.ProcessEnv,
  isTTY = process.stdout.isTTY === true,
): Promise<TmuxNames> {
  const pane = env.TMUX_PANE
  if (!env.TMUX || !pane || !isTTY) return {}
  const read = async (format: string): Promise<string | undefined> => {
    try {
      const r = await pi.exec("tmux", ["display-message", "-p", "-t", pane, format], { timeout: TMUX_TIMEOUT_MS })
      if (r.code !== 0) return undefined
      return r.stdout.replace(/\r?\n$/, "") || undefined
    } catch {
      return undefined
    }
  }
  const [window, session] = await Promise.all([read("#{window_name}"), read("#{session_name}")])
  return { window, session }
}

function contextAddress(ctx: ExtensionContext, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const fromBranch = currentContext(ctx.sessionManager.getBranch() as never)
    if (fromBranch) return fromBranch
  } catch {}
  return env.CUE_CONTEXT?.trim() || undefined
}

/** Title of a context read from the cue store; undefined when unreadable. */
export function readContextTitle(address: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (!address || address.split("/").includes("..")) return undefined
  try {
    const store = env.CUE_STORE?.trim() || join(homedir(), "cue")
    return contextTitleOf(readFileSync(join(store, address, "context.md"), "utf8"))
  } catch {
    return undefined
  }
}

function activeTask(ctx: ExtensionContext): string | undefined {
  try {
    return currentTask(ctx.sessionManager.getBranch() as never)
  } catch {
    return undefined
  }
}

function sessionDescription(ctx: ExtensionContext): string | undefined {
  try {
    const branch = ctx.sessionManager.getBranch()
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i]
      if (entry?.type === "custom" && entry.customType === "session-description") {
        const text = (entry.data as { text?: unknown } | undefined)?.text
        return typeof text === "string" ? text.trim() || undefined : undefined
      }
    }
  } catch {}
  return undefined
}

function identity(ctx: ExtensionContext, host: string, env: NodeJS.ProcessEnv): AgentIdentity {
  const sid = ctx.sessionManager.getSessionId()
  const context = contextAddress(ctx, env)
  return {
    sid,
    host,
    mode: ctx.mode,
    cwd: ctx.cwd,
    session_file: ctx.sessionManager.getSessionFile(),
    session_name: ctx.sessionManager.getSessionName(),
    session_description: sessionDescription(ctx),
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    context,
    context_title: readContextTitle(context, env),
    active_task: activeTask(ctx),
    run_id: runIdOf(sid),
    agent: agentNameOf(env),
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
  const tmuxNames = options.tmuxNames ?? (() => readTmuxNames(pi, env))

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
    const context = contextAddress(ctx, env)
    if (context !== undefined && context !== tracker.row.context) {
      delete tracker.row.context_title
      tracker.update({ context_title: readContextTitle(context, env) })
    }
    delete tracker.row.active_task
    tracker.update({
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      context,
      active_task: activeTask(ctx),
    })
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

  pi.on("agent_settled", async (event, ctx) => {
    if (!tracker) return
    const t = tracker
    const names = await tmuxNames().catch((): TmuxNames => ({}))
    if (tracker !== t) return
    delete t.row.session_description
    delete t.row.tmux_window
    delete t.row.tmux_session
    delete t.row.active_task
    t.update({
      session_description: sessionDescription(ctx),
      active_task: activeTask(ctx),
      tmux_window: names.window,
      tmux_session: names.session,
    })
    emitAndPut(t.settled(event.aborted))
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
