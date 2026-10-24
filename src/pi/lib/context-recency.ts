import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/**
 * Recency blocks for context orientation: how long this context has been
 * quiet, what its children (grandchildren rolled up) did meanwhile, and
 * which artifacts it created most recently. Everything is derived from
 * the logs and activity streams; children never write into this context.
 *
 * "Last activity" is the newest log entry. Activity events are not used
 * for it, because merely opening a session records one.
 */

export interface ChildRow {
  address: string
  logs: number
  artifacts: number
}

export interface RecentArtifact {
  address: string
  timestamp: number
}

interface LogEntry {
  timestamp: number
}

interface ActivityEvent {
  timestamp: number
  kind: string
  details?: { address?: string }
}

const RECENT_ARTIFACTS = 5
const NS_PER_MS = 1_000_000

/** Relative age, coarsest unit that is at least one. */
export function formatAge(thenMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - thenMs) / 60_000))
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const unit = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"} ago`
  if (days > 0) return unit(days, "day")
  if (hours > 0) return unit(hours, "hour")
  if (minutes > 0) return unit(minutes, "minute")
  return "just now"
}

export function renderLastActivity(
  lastMs: number | undefined,
  nowMs: number,
): string {
  if (lastMs === undefined) return "Last activity: none (no log entries)"
  return `Last activity: ${formatAge(lastMs, nowMs)}`
}

/**
 * Whitespace-aligned table, one row per child, zero rows included so the
 * list of children stays complete. The hint follows only when some child
 * has activity.
 */
export function renderChildrenTable(rows: ChildRow[]): string {
  if (rows.length === 0) return ""
  const header: [string, string, string] = ["child", "logs", "artifacts"]
  const cells = rows.map(
    (r) => [r.address, String(r.logs), String(r.artifacts)] as const,
  )
  const w0 = Math.max(header[0].length, ...cells.map((c) => c[0].length))
  const w1 = Math.max(header[1].length, ...cells.map((c) => c[1].length))
  const w2 = Math.max(header[2].length, ...cells.map((c) => c[2].length))
  const line = (a: string, b: string, c: string) =>
    `${a.padEnd(w0)}  ${b.padStart(w1)}  ${c.padStart(w2)}`
  const table = [
    line(...header),
    ...cells.map((c) => line(c[0], c[1], c[2])),
  ].join("\n")
  const block = `<children since-last-activity>\n${table}\n</children>`
  const active = rows.some((r) => r.logs > 0 || r.artifacts > 0)
  if (!active) return block
  return (
    `${block}\n` +
    "Children above have logged work since this context's last activity;\n" +
    "check their logs before answering about recent progress."
  )
}

/** Latest artifacts, deduped by address, newest first. */
export function recentArtifacts(
  events: ActivityEvent[],
  limit = RECENT_ARTIFACTS,
): RecentArtifact[] {
  const latest = new Map<string, number>()
  for (const e of events) {
    const address = e.details?.address
    if (e.kind !== "artifact_created" || !address) continue
    const prev = latest.get(address)
    if (prev === undefined || e.timestamp > prev) latest.set(address, e.timestamp)
  }
  return [...latest]
    .map(([address, timestamp]) => ({ address, timestamp }))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit)
}

export function renderRecentArtifacts(
  items: RecentArtifact[],
  nowMs: number,
): string {
  if (items.length === 0) return ""
  const ages = items.map((i) => formatAge(i.timestamp, nowMs))
  const w = Math.max(...ages.map((a) => a.length))
  const lines = items.map((i, n) => `${ages[n]!.padEnd(w)}  ${i.address}`)
  return `<recent-artifacts>\n${lines.join("\n")}\n</recent-artifacts>`
}

async function execJson<T>(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
): Promise<T | undefined> {
  try {
    const r = await pi.exec("cue", args, { cwd })
    if (r.code !== 0) return undefined
    return JSON.parse(r.stdout || "null") as T
  } catch {
    return undefined
  }
}

async function listChildren(
  pi: ExtensionAPI,
  cwd: string,
  address: string,
): Promise<string[]> {
  try {
    const r = await pi.exec(
      "cue",
      ["context", "list", "--scope", "store", "--filter", `parent=${address}`],
      { cwd },
    )
    if (r.code !== 0) return []
    return r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
  } catch {
    return []
  }
}

/** Every descendant of `address`, guarding against parent cycles. */
async function descendants(
  pi: ExtensionAPI,
  cwd: string,
  address: string,
  seen: Set<string>,
): Promise<string[]> {
  const kids = (await listChildren(pi, cwd, address)).filter(
    (k) => !seen.has(k),
  )
  kids.forEach((k) => seen.add(k))
  const nested = await Promise.all(
    kids.map((k) => descendants(pi, cwd, k, seen)),
  )
  return [...kids, ...nested.flat()]
}

async function logTimestampsMs(
  pi: ExtensionAPI,
  cwd: string,
  address: string,
): Promise<number[]> {
  const entries = await execJson<LogEntry[]>(pi, cwd, [
    "log",
    "list",
    "--context",
    address,
  ])
  return (entries ?? []).map((e) => Math.floor(e.timestamp / NS_PER_MS))
}

async function activity(
  pi: ExtensionAPI,
  cwd: string,
  address: string,
  sinceMs?: number,
): Promise<ActivityEvent[]> {
  const args = ["activity", "list", "--context", address, "--json"]
  if (sinceMs !== undefined) args.push("--since", String(sinceMs))
  return (await execJson<ActivityEvent[]>(pi, cwd, args)) ?? []
}

async function countSince(
  pi: ExtensionAPI,
  cwd: string,
  address: string,
  sinceMs: number | undefined,
): Promise<{ logs: number; artifacts: number }> {
  const [logs, events] = await Promise.all([
    logTimestampsMs(pi, cwd, address),
    activity(pi, cwd, address, sinceMs === undefined ? undefined : sinceMs + 1),
  ])
  return {
    logs: logs.filter((t) => sinceMs === undefined || t > sinceMs).length,
    artifacts: events.filter((e) => e.kind === "artifact_created").length,
  }
}

async function childRow(
  pi: ExtensionAPI,
  cwd: string,
  child: string,
  sinceMs: number | undefined,
  seen: Set<string>,
): Promise<ChildRow> {
  const nodes = [child, ...(await descendants(pi, cwd, child, seen))]
  const counts = await Promise.all(
    nodes.map((n) => countSince(pi, cwd, n, sinceMs)),
  )
  return {
    address: child,
    logs: counts.reduce((s, c) => s + c.logs, 0),
    artifacts: counts.reduce((s, c) => s + c.artifacts, 0),
  }
}

/**
 * Gather the recency sections for `address`: the last-activity line
 * followed by the children table, and the recent-artifacts block. Each
 * is "" when there is nothing to show; failures degrade to omission.
 */
export async function contextRecency(
  pi: ExtensionAPI,
  cwd: string,
  address: string,
  nowMs = Date.now(),
): Promise<{ recency: string; artifacts: string }> {
  const [own, ownEvents, children] = await Promise.all([
    logTimestampsMs(pi, cwd, address),
    activity(pi, cwd, address),
    listChildren(pi, cwd, address),
  ])
  const lastMs = own.length > 0 ? Math.max(...own) : undefined
  const seen = new Set<string>([address, ...children])
  const rows = await Promise.all(
    children.map((c) => childRow(pi, cwd, c, lastMs, seen)),
  )
  const recency = [
    renderLastActivity(lastMs, nowMs),
    renderChildrenTable(rows),
  ]
    .filter((s) => s !== "")
    .join("\n\n")
  const artifacts = renderRecentArtifacts(recentArtifacts(ownEvents), nowMs)
  return { recency, artifacts }
}
