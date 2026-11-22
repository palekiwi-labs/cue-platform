export const FINDING_STATUSES = ["open", "applied", "dismissed"] as const
export type FindingStatus = typeof FINDING_STATUSES[number]

export interface FindingStatusChanged {
  v: 1
  ts: string
  context: string
  artifact_address: string
  finding_id: string
  old_status: string | null
  new_status: FindingStatus
  actor: "operator"
}

export function operatorSubject(context: string, kind = "finding_status_changed"): string {
  return `operator.evt.v1.${Buffer.from(context, "utf8").toString("base64url")}.${kind}`
}

export function isContextAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= 512
    && /^[\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+$/u.test(value)
    && value.split("/").every(p => p !== "." && p !== "..")
}

export function isFindingStatus(value: unknown): value is FindingStatus {
  return FINDING_STATUSES.includes(value as FindingStatus)
}

export function parseOperatorEvent(value: unknown, context: string): FindingStatusChanged | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const e = value as Record<string, unknown>
  if (e.v !== 1 || e.actor !== "operator" || e.context !== context || !isContextAddress(e.context)) return
  if (typeof e.ts !== "string" || !/^\d{4}-\d\d-\d\dT/.test(e.ts) || !Number.isFinite(Date.parse(e.ts))) return
  if (typeof e.artifact_address !== "string" || !e.artifact_address.startsWith(`${context}/review/`)
    || e.artifact_address.length > 1024 || e.artifact_address.split("/").some(p => !p || p === "." || p === "..")
    || !/^[\p{L}\p{N}_./-]+$/u.test(e.artifact_address)) return
  if (typeof e.finding_id !== "string" || !/^[\w.-]{1,128}$/.test(e.finding_id)) return
  if (e.old_status !== null && (typeof e.old_status !== "string" || !/^[\w-]{1,32}$/.test(e.old_status))) return
  if (!isFindingStatus(e.new_status)) return
  return e as unknown as FindingStatusChanged
}

export class PendingOperatorChanges {
  private readonly entries = new Map<string, FindingStatusChanged>()
  private overflow = 0
  private readonly storeLines = new Map<string, string>()
  private storeOverflow = 0
  private readonly seen = new Set<string>()

  constructor(private readonly limit = 100, private readonly seenLimit = 1000) {}

  clear(): void {
    this.entries.clear()
    this.overflow = 0
    this.storeLines.clear()
    this.storeOverflow = 0
  }

  addStoreEvent(eventId: string, line: string): void {
    if (this.seen.has(eventId)) return
    this.seen.add(eventId)
    if (this.seen.size > this.seenLimit) this.seen.delete(this.seen.values().next().value!)
    if (this.storeLines.size < this.limit) this.storeLines.set(eventId, line)
    else this.storeOverflow = Math.min(Number.MAX_SAFE_INTEGER, this.storeOverflow + 1)
  }

  add(event: FindingStatusChanged): void {
    const key = JSON.stringify([event.artifact_address, event.finding_id])
    const previous = this.entries.get(key)
    const next = { ...event, old_status: previous ? previous.old_status : event.old_status }
    if (next.old_status === next.new_status) this.entries.delete(key)
    else if (previous || this.entries.size < this.limit) this.entries.set(key, next)
    else this.overflow = Math.min(Number.MAX_SAFE_INTEGER, this.overflow + 1)
  }

  take(context: string): string | undefined {
    if (!this.entries.size && !this.overflow && !this.storeLines.size && !this.storeOverflow) return
    const changes = [...this.entries.values()].map(e =>
      `[operator] ${e.finding_id} ${e.old_status ?? "unset"} -> ${e.new_status} (${shortLocation(e.artifact_address, context)})`)
    if (this.overflow) changes.push(`[operator] ${this.overflow} more changes`)
    changes.push(...this.storeLines.values())
    if (this.storeOverflow) changes.push(`[cue] ${this.storeOverflow} more events`)
    this.clear()
    return ["<operator-events>", ...changes, "</operator-events>"].join("\n")
  }
}

function shortLocation(artifact: string, context: string): string {
  const prefix = `${context}/review/`
  const path = artifact.startsWith(prefix) ? artifact.slice(prefix.length) : artifact
  const cut = path.lastIndexOf("/")
  return cut < 0 ? path : `${path.slice(0, cut)}, ${path.slice(cut + 1)}`
}
