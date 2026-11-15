export const SCHEMA_VERSION = 1
export const EVENT_STREAM = "AGENT_EVENTS"
export const REGISTRY_BUCKET = "agents"
export const EVENT_SUBJECT_ROOT = "agent.evt"
export const DEFAULT_JS_DOMAIN = "pale"
export const JS_DOMAIN_ENV = "CUE_NATS_JS_DOMAIN"

export const INPUT_PREVIEW_CHARS = 200
export const ARG_PREVIEW_CHARS = 300
export const ERROR_PREVIEW_CHARS = 300
export const MAX_MSG_BYTES = 8 * 1024

export type EventKind =
  | "start"
  | "input"
  | "turn_start"
  | "turn_end"
  | "thinking"
  | "tool_start"
  | "tool_end"
  | "settled"
  | "error"
  | "compact"
  | "end"

export type AgentState = "busy" | "idle" | "error"

/** Identity of one live pi session, shared by its events and registry row. */
export interface AgentIdentity {
  sid: string
  host: string
  mode?: string
  cwd?: string
  session_file?: string
  session_name?: string
  model?: string
  context?: string
  context_title?: string
  run_id?: string
  agent?: string
  pid?: number
}

/** One message on `agent.evt.<sid>.<kind>`. */
export interface AgentEvent {
  v: number
  ts: number
  sid: string
  host: string
  kind: EventKind
  seq: number
  [field: string]: unknown
}

/** Value of the `agents` KV entry keyed by sid. */
export interface RegistryRow extends AgentIdentity {
  v: number
  state: AgentState
  error?: string
  last_tool?: string
  turns: number
  tokens: number
  cost: number
  started_at: number
  updated_at: number
}

export function resolveJsDomain(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[JS_DOMAIN_ENV]
  if (raw === undefined) return DEFAULT_JS_DOMAIN
  const trimmed = raw.trim()
  return trimmed ? trimmed : undefined
}

/** The cue-agent agent name a session runs as, from `CUE_AGENT_NAME`. */
export function agentNameOf(env: NodeJS.ProcessEnv): string | undefined {
  return env.CUE_AGENT_NAME?.trim() || undefined
}

function scalar(raw: string): string | undefined {
  const value = raw.trim()
  if (!value) return undefined
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return (JSON.parse(value) as string).trim() || undefined
    } catch {
      return undefined
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'").trim() || undefined
  }
  return value.replace(/\s+#.*$/, "").trim() || undefined
}

/**
 * Title of a context from its `context.md`: the frontmatter `title`,
 * falling back to `description`. Single-line scalars only.
 */
export function contextTitleOf(markdown: string): string | undefined {
  const lines = markdown.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") return undefined
  const fields: Record<string, string | undefined> = {}
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break
    const m = /^(title|description):(.*)$/.exec(line)
    if (m) fields[m[1] as string] = scalar(m[2] as string)
  }
  const title = fields.title ?? fields.description
  return title ? truncate(title, INPUT_PREVIEW_CHARS) : undefined
}

/** Make an arbitrary id usable as a single NATS subject token and KV key. */
export function subjectToken(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_=-]/g, "_")
  return cleaned || "_"
}

export function eventSubject(sid: string, kind: EventKind): string {
  return `${EVENT_SUBJECT_ROOT}.${subjectToken(sid)}.${kind}`
}

export function sessionEventsFilter(sid: string): string {
  return `${EVENT_SUBJECT_ROOT}.${subjectToken(sid)}.>`
}

export function registrySubject(sid: string, domain: string | undefined): string {
  const prefix = domain ? `$JS.${domain}.API.` : ""
  return `${prefix}$KV.${REGISTRY_BUCKET}.${subjectToken(sid)}`
}

const RUN_ID = /^\d{8}-\d{6}-[0-9a-f]{6}-[a-z0-9-]+-\d+$/

/** The cue-agent run id when `sid` is one: cue-agent passes it as pi's session id. */
export function runIdOf(sid: string): string | undefined {
  return RUN_ID.test(sid) ? sid : undefined
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}\u2026`
}

function stringField(args: unknown, ...keys: string[]): string | undefined {
  if (!args || typeof args !== "object") return undefined
  const rec = args as Record<string, unknown>
  for (const key of keys) {
    const value = rec[key]
    if (typeof value === "string" && value) return value
  }
  return undefined
}

/** Short human preview of a tool call's arguments. */
export function argPreview(toolName: string, args: unknown, max = ARG_PREVIEW_CHARS): string {
  let text: string | undefined
  switch (toolName) {
    case "bash":
      text = stringField(args, "command")
      break
    case "read":
    case "edit":
    case "write":
      text = stringField(args, "path", "file_path")
      break
    case "grep":
    case "find":
      text = stringField(args, "pattern")
      break
    case "ls":
      text = stringField(args, "path") ?? "."
      break
  }
  if (text === undefined) {
    try {
      text = JSON.stringify(args) ?? ""
    } catch {
      text = ""
    }
  }
  return truncate(text, max)
}

/** Serialise an event, shrinking string fields until it fits the stream limit. */
export function encodeEvent(event: AgentEvent, maxBytes = MAX_MSG_BYTES): string {
  let json = JSON.stringify(event)
  if (Buffer.byteLength(json) <= maxBytes) return json
  const shrunk: AgentEvent = { ...event }
  for (const [key, value] of Object.entries(shrunk)) {
    if (typeof value === "string" && value.length > 64) shrunk[key] = truncate(value, 64)
  }
  json = JSON.stringify(shrunk)
  if (Buffer.byteLength(json) <= maxBytes) return json
  const { v, ts, sid, host, kind, seq } = event
  return JSON.stringify({ v, ts, sid, host, kind, seq, truncated: true })
}

interface UsageLike {
  totalTokens?: number
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  cost?: { total?: number }
}

/** Tokens and cost of one assistant message, zero when it reports none. */
export function messageUsage(message: unknown): { tokens: number; cost: number } {
  if (!message || typeof message !== "object") return { tokens: 0, cost: 0 }
  const m = message as { role?: string; usage?: UsageLike }
  if (m.role !== "assistant" || !m.usage) return { tokens: 0, cost: 0 }
  const u = m.usage
  const tokens =
    typeof u.totalTokens === "number"
      ? u.totalTokens
      : (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)
  const cost = typeof u.cost?.total === "number" ? u.cost.total : 0
  return { tokens, cost }
}

/** Error text of an assistant message that stopped with an error. */
export function messageError(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined
  const m = message as { role?: string; stopReason?: string; errorMessage?: string }
  if (m.role !== "assistant" || m.stopReason !== "error") return undefined
  return truncate(m.errorMessage || "error", ERROR_PREVIEW_CHARS)
}

/**
 * State of one pi session: turns each pi event into the event to publish
 * and keeps the registry row current. Pure; the clock is injected.
 */
export class SessionTracker {
  private seq = 0
  private thinkingSent = false
  private toolStarts = new Map<string, number>()
  private busySince: number | undefined
  private toolsDone = 0
  readonly row: RegistryRow

  constructor(
    identity: AgentIdentity,
    private readonly now: () => number = Date.now,
  ) {
    const ts = now()
    this.row = {
      ...identity,
      v: SCHEMA_VERSION,
      state: "idle",
      turns: 0,
      tokens: 0,
      cost: 0,
      started_at: ts,
      updated_at: ts,
    }
  }

  get sid(): string {
    return this.row.sid
  }

  private event(kind: EventKind, fields: Record<string, unknown> = {}): AgentEvent {
    const ts = this.now()
    this.row.updated_at = ts
    return { v: SCHEMA_VERSION, ts, sid: this.row.sid, host: this.row.host, kind, seq: ++this.seq, ...fields }
  }

  /** Refresh identity fields that can change during a session. */
  update(fields: Partial<AgentIdentity>): void {
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) (this.row as unknown as Record<string, unknown>)[key] = value
    }
  }

  touch(): void {
    this.row.updated_at = this.now()
  }

  start(reason: string): AgentEvent {
    const { sid: _sid, host: _host, v: _v, state: _s, turns: _t, tokens: _k, cost: _c, ...identity } = this.row
    return this.event("start", { reason, ...identity })
  }

  private markBusy(): void {
    this.row.state = "busy"
    if (this.busySince === undefined) {
      this.busySince = this.now()
      this.toolsDone = 0
    }
  }

  input(text: string, source: string): AgentEvent {
    this.markBusy()
    delete this.row.error
    const { model, context } = this.row
    return this.event("input", { source, preview: truncate(text, INPUT_PREVIEW_CHARS), model, context })
  }

  turnStart(turn: number): AgentEvent {
    this.markBusy()
    this.thinkingSent = false
    return this.event("turn_start", { turn })
  }

  /** The `thinking` marker, at most once per turn. */
  thinking(): AgentEvent | undefined {
    if (this.thinkingSent) return undefined
    this.thinkingSent = true
    return this.event("thinking")
  }

  turnEnd(turn: number, message: unknown): AgentEvent {
    const usage = messageUsage(message)
    this.row.turns += 1
    this.row.tokens += usage.tokens
    this.row.cost += usage.cost
    return this.event("turn_end", { turn })
  }

  toolStart(callId: string, toolName: string, args: unknown): AgentEvent {
    this.toolStarts.set(callId, this.now())
    const preview = argPreview(toolName, args)
    this.row.last_tool = `${toolName} ${preview}`.trim()
    return this.event("tool_start", { call_id: callId, tool: toolName, args: preview })
  }

  toolEnd(callId: string, toolName: string, isError: boolean, durationMs?: number): AgentEvent {
    const startedAt = this.toolStarts.get(callId)
    this.toolStarts.delete(callId)
    const duration = durationMs ?? (startedAt === undefined ? undefined : this.now() - startedAt)
    this.toolsDone += 1
    return this.event("tool_end", { call_id: callId, tool: toolName, ok: !isError, duration_ms: duration })
  }

  error(message: string): AgentEvent {
    this.row.state = "error"
    this.row.error = truncate(message, ERROR_PREVIEW_CHARS)
    return this.event("error", { message: this.row.error })
  }

  settled(aborted: boolean): AgentEvent {
    const errored = this.row.state === "error"
    if (!errored) this.row.state = "idle"
    const turnMs = this.busySince === undefined ? undefined : this.now() - this.busySince
    const tools = this.toolsDone
    this.busySince = undefined
    this.toolsDone = 0
    const { context, context_title, session_name, cwd, run_id, agent } = this.row
    const fields: Record<string, unknown> = {
      aborted,
      errored,
      context,
      context_title,
      session_name,
      cwd,
      run_id,
      agent,
      turn_ms: turnMs,
      tools,
    }
    for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key]
    return this.event("settled", fields)
  }

  compact(reason: string): AgentEvent {
    return this.event("compact", { reason })
  }

  end(reason: string): AgentEvent {
    return this.event("end", { reason, turns: this.row.turns, cost: this.row.cost })
  }

  /** Nats-Msg-Id for an event, so resends inside the duplicate window collapse. */
  msgId(event: AgentEvent): string {
    return `${event.sid}-${this.row.started_at}-${event.seq}`
  }
}
