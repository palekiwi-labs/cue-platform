import { branchPath, type Entry, isAssistant, promptTokens, type Usage } from "./entries"
import { diffSnapshots, isSnapshot, SNAPSHOT_TYPE, type Snapshot } from "./snapshot"

/** Prompt-cache TTL used to attribute misses to idle gaps (pi cache-stats). */
export const CACHE_TTL_MS = 5 * 60 * 1000

/** Misses at or below this are breakpoint granularity noise (pi cache-stats). */
export const NOISE_FLOOR_TOKENS = 1024

export type MissCause = "idle" | "model" | "prefix" | "compaction" | "unknown"

export type Turn = {
  index: number
  entryId: string
  timestamp: number
  model: string
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  prompt: number
  context: number
  hitRatio: number | null
  stopReason?: string
  miss?: Miss
  afterCompaction?: boolean
}

export type Miss = {
  missedTokens: number
  idleMs: number
  modelChanged: boolean
  causes: MissCause[]
  prefixChanges: string[]
}

export type CacheSummary = {
  turns: Turn[]
  totals: { input: number; cacheRead: number; cacheWrite: number; output: number; prompt: number }
  hitRatio: number | null
  misses: number
  missedTokens: number
  compactions: number
  compactionRebuilds: number
  compactionTokens: number
  reportsCache: boolean
}

type Prev = { prompt: number; model: string; timestamp: number; reportedCache: boolean }

function changesBetween(a: Snapshot | null, b: Snapshot | null): string[] {
  if (!a || !b || a.hash === b.hash) return []
  const d = diffSnapshots(a, b)
  const out: string[] = []
  for (const s of d.sections) out.push(`section ${s.name} ${s.change}`)
  for (const t of d.tools) out.push(`tool ${t.name} ${t.change}`)
  if (d.activeAdded.length) out.push(`active +${d.activeAdded.join(",")}`)
  if (d.activeRemoved.length) out.push(`active -${d.activeRemoved.join(",")}`)
  return out
}

function systemUpdateLabel(e: Entry): string | null {
  const m = e.message
  if (e.type !== "message" || m?.role !== "system") return null
  const parts: string[] = []
  for (const k of Object.keys(m.sections ?? {})) parts.push(`section ${k}`)
  for (const t of m.toolsAdded ?? []) parts.push(`tool +${t.name}`)
  for (const t of m.toolsRemoved ?? []) parts.push(`tool -${t.name}`)
  return parts.length ? `system update: ${parts.join(", ")}` : null
}

/**
 * Per-turn usage and cache misses from recorded assistant usage, following
 * the logic of pi's cache-stats: a miss is prompt tokens that were in the
 * previous request's prompt but were not read from cache, above a noise
 * floor. Compactions and branch summaries reset the baseline; cache_warm
 * usage entries refresh it. Causes: idle beyond the TTL, model change, a
 * recorded prefix change (snapshot diff or mid-conversation system update)
 * since the previous turn, else unknown.
 *
 * pi does not count the first turn after a compaction as a miss; it is
 * reported here as a `compaction` rebuild (uncached prompt tokens) and
 * kept out of `misses`.
 */
export function analyseCache(entries: Entry[]): CacheSummary {
  const path = branchPath(entries)
  const turns: Turn[] = []
  const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, prompt: 0 }
  let prev: Prev | undefined
  let compactions = 0
  let reportsCache = false
  let afterCompaction = false
  let snapshot: Snapshot | null = null
  let prevSnapshot: Snapshot | null = null
  let pendingChanges: string[] = []

  for (const e of path) {
    if (e.type === "compaction" || e.type === "branch_summary") {
      if (e.type === "compaction") compactions++
      prev = undefined
      afterCompaction = true
      continue
    }
    if (e.type === "custom" && e.customType === SNAPSHOT_TYPE && isSnapshot(e.data)) {
      snapshot = e.data
      continue
    }
    const sys = systemUpdateLabel(e)
    if (sys && turns.length > 0) pendingChanges.push(sys)
    if (e.type === "usage" && e.kind === "cache_warm" && e.usage) {
      const p = promptTokens(e.usage)
      if (p > 0) prev = { prompt: p, model: `${e.provider}/${e.model}`, timestamp: Date.parse(e.timestamp), reportedCache: true }
      continue
    }
    if (!isAssistant(e) || !e.message?.usage) continue
    const m = e.message
    const u: Usage = m.usage!
    const prompt = promptTokens(u)
    const model = `${m.provider}/${m.model}`
    const timestamp = m.timestamp ?? Date.parse(e.timestamp)
    if (prompt <= 0) continue
    if (u.cacheRead + u.cacheWrite > 0) reportsCache = true

    const turn: Turn = {
      index: turns.length + 1,
      entryId: e.id,
      timestamp,
      model,
      input: u.input,
      cacheRead: u.cacheRead,
      cacheWrite: u.cacheWrite,
      output: u.output,
      prompt,
      context: prompt + u.output,
      hitRatio: prompt > 0 ? u.cacheRead / prompt : null,
      stopReason: m.stopReason,
      ...(afterCompaction ? { afterCompaction: true } : {}),
    }
    afterCompaction = false

    const changes = [...pendingChanges, ...changesBetween(prevSnapshot, snapshot)]
    pendingChanges = []
    prevSnapshot = snapshot

    const counted = prev && !(u.cacheRead + u.cacheWrite === 0 && !prev.reportedCache)
    if (!prev && turn.afterCompaction && reportsCache && prompt - u.cacheRead > NOISE_FLOOR_TOKENS) {
      turn.miss = {
        missedTokens: prompt - u.cacheRead,
        idleMs: 0,
        modelChanged: false,
        causes: ["compaction"],
        prefixChanges: changes,
      }
    }
    if (prev && counted) {
      const missed = Math.min(prev.prompt, prompt) - u.cacheRead
      if (missed > NOISE_FLOOR_TOKENS) {
        const idleMs = Math.max(0, timestamp - prev.timestamp)
        const modelChanged = model !== prev.model
        const causes: MissCause[] = []
        if (idleMs > CACHE_TTL_MS) causes.push("idle")
        if (modelChanged) causes.push("model")
        if (changes.length) causes.push("prefix")
        if (!causes.length) causes.push("unknown")
        turn.miss = { missedTokens: missed, idleMs, modelChanged, causes, prefixChanges: changes }
      }
    }
    prev = {
      prompt,
      model,
      timestamp,
      reportedCache: (prev?.reportedCache ?? false) || u.cacheRead + u.cacheWrite > 0,
    }

    totals.input += u.input
    totals.cacheRead += u.cacheRead
    totals.cacheWrite += u.cacheWrite
    totals.output += u.output
    totals.prompt += prompt
    turns.push(turn)
  }

  const misses = turns.filter((t) => t.miss && !t.miss.causes.includes("compaction"))
  const rebuilds = turns.filter((t) => t.miss?.causes.includes("compaction"))
  return {
    turns,
    totals,
    hitRatio: totals.prompt > 0 ? totals.cacheRead / totals.prompt : null,
    misses: misses.length,
    missedTokens: misses.reduce((n, t) => n + (t.miss?.missedTokens ?? 0), 0),
    compactions,
    compactionRebuilds: rebuilds.length,
    compactionTokens: rebuilds.reduce((n, t) => n + (t.miss?.missedTokens ?? 0), 0),
    reportsCache,
  }
}
