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
  return typeof value === "string" && /^[^/\s.]+\/[^/\s.]+\/[^/\s.]+$/.test(value)
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
    || /[\s\x00-\x1f\x7f]/.test(e.artifact_address)) return
  if (typeof e.finding_id !== "string" || !/^[\w.-]{1,128}$/.test(e.finding_id)) return
  if (e.old_status !== null && (typeof e.old_status !== "string" || !/^[\w-]{1,32}$/.test(e.old_status))) return
  if (!isFindingStatus(e.new_status)) return
  return e as unknown as FindingStatusChanged
}

export class PendingOperatorChanges {
  private readonly entries = new Map<string, FindingStatusChanged>()
  private overflow = 0

  constructor(private readonly limit = 100) {}

  clear(): void {
    this.entries.clear()
    this.overflow = 0
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
    if (!this.entries.size && !this.overflow) return
    const changes = [...this.entries.values()].map(e =>
      `finding ${e.finding_id} (${e.artifact_address}) ${e.old_status ?? "unset"} -> ${e.new_status}`)
    if (this.overflow) changes.push(`${this.overflow} more changes (not retained)`)
    this.clear()
    return `Observed operator changes since your last message (review station, ${context}): ${changes.join("; ")}.`
  }
}
