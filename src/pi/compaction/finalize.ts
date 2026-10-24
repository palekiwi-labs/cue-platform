import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import {
  ARCHIVE_DIR,
  type CompactedBlock,
  entryCount,
  entryFrom,
  fileStamp,
  type LiveEntry,
  type LogEntryJson,
  PENDING_SUFFIX,
  readLive,
} from "./log-files"
import { type Bundle, logDir } from "./prepare"
import type { Proposal, ProposedSummary } from "./proposal"

/**
 * finalize: apply a validated proposal to the live log.
 *
 * Per summary, in recoverable order: create the archive dir with an
 * APPLYING marker, copy the originals, write the manifest, write the
 * summary as `<last>.json.pending`, delete the other originals, rename
 * the summary over the last original, remove the marker. A crash leaves
 * the marker behind; `recover` completes or rolls back from it.
 */

export const MANIFEST_FILE = "manifest.json"
export const APPLYING_MARKER = "APPLYING"

export interface Manifest {
  from: string
  to: string
  count: number
  compacted_at: number
  /** Live file name of the summary entry. */
  summary: string
  entries: { file: string; title: string; trace: string | null }[]
}

export interface AppliedSummary {
  summary: string
  archive: string
  replaced: number
}

export type FinalizeResult =
  | { ok: true; applied: AppliedSummary[] }
  | { ok: false; reason: string }

interface Paths {
  store: string
  address: string
}

function pad(stamp: string): string {
  return stamp.padStart(20, "0")
}

/** Summary JSON with the nanosecond `timestamp` emitted as raw digits. */
export function summaryJson(s: ProposedSummary, compacted: CompactedBlock): string {
  const body = JSON.stringify(
    {
      timestamp: "__TS__",
      title: s.title,
      trace: s.trace,
      found: s.found,
      decided: s.decided,
      open: s.open,
      compacted,
    },
    null,
    2,
  )
  return body.replace('"__TS__"', compacted.to)
}

/** Files whose hashes no longer match the snapshot. */
export function snapshotDrift(dir: string, bundle: Bundle): string[] {
  const current = new Map(readLive(dir).map((e) => [e.file, e.sha256]))
  return bundle.snapshot.filter((s) => current.get(s.file) !== s.sha256).map((s) => s.file)
}

function applyOne(paths: Paths, dir: string, live: Map<string, LiveEntry>, s: ProposedSummary): AppliedSummary {
  const covered = s.covers.map((f) => live.get(f)!)
  const last = s.covers[s.covers.length - 1]!
  const from = entryFrom(covered[0]!)
  const to = fileStamp(last)
  const name = `${pad(from)}-${pad(to)}`
  const archive = `${paths.address}/log/${ARCHIVE_DIR}/${name}`
  const archiveDir = join(paths.store, archive)
  if (existsSync(archiveDir)) throw new Error(`archive ${archive} already exists`)
  mkdirSync(archiveDir, { recursive: true })
  writeFileSync(join(archiveDir, APPLYING_MARKER), "")
  for (const file of s.covers) copyFileSync(join(dir, file), join(archiveDir, file))
  const count = covered.reduce((n, e) => n + entryCount(e), 0)
  const manifest: Manifest = {
    from,
    to,
    count,
    compacted_at: Math.floor(Date.now() / 1000),
    summary: last,
    entries: covered.map((e) => ({ file: e.file, title: e.entry.title, trace: e.entry.trace ?? null })),
  }
  writeFileSync(join(archiveDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2))
  const pending = join(dir, last + PENDING_SUFFIX)
  writeFileSync(pending, summaryJson(s, { from, to, count, archive }))
  for (const file of s.covers.slice(0, -1)) unlinkSync(join(dir, file))
  renameSync(pending, join(dir, last))
  unlinkSync(join(archiveDir, APPLYING_MARKER))
  return { summary: `${paths.address}/log/${last}`, archive, replaced: s.covers.length }
}

/**
 * Complete or roll back every half-applied archive in a log. A pending
 * summary means originals may already be gone: roll forward. Without
 * one, the originals are intact (or the rename already happened): roll
 * back by removing the archive, or just drop the marker.
 */
export function recover(paths: Paths): string[] {
  const dir = logDir(paths)
  const root = join(dir, ARCHIVE_DIR)
  if (!existsSync(root)) return []
  const actions: string[] = []
  for (const name of readdirSync(root).sort()) {
    const archiveDir = join(root, name)
    if (!existsSync(join(archiveDir, APPLYING_MARKER))) continue
    const archive = `${paths.address}/log/${ARCHIVE_DIR}/${name}`
    const manifestPath = join(archiveDir, MANIFEST_FILE)
    if (!existsSync(manifestPath)) {
      rmSync(archiveDir, { recursive: true, force: true })
      actions.push(`rolled back ${archive}`)
      continue
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
    const pending = join(dir, manifest.summary + PENDING_SUFFIX)
    if (existsSync(pending)) {
      for (const e of manifest.entries) {
        if (e.file !== manifest.summary) rmSync(join(dir, e.file), { force: true })
      }
      renameSync(pending, join(dir, manifest.summary))
      unlinkSync(join(archiveDir, APPLYING_MARKER))
      actions.push(`completed ${archive}`)
      continue
    }
    const livePath = join(dir, manifest.summary)
    const liveEntry = existsSync(livePath)
      ? (JSON.parse(readFileSync(livePath, "utf8")) as LogEntryJson)
      : undefined
    if (liveEntry?.compacted?.archive === archive) {
      unlinkSync(join(archiveDir, APPLYING_MARKER))
      actions.push(`completed ${archive}`)
    } else {
      rmSync(archiveDir, { recursive: true, force: true })
      actions.push(`rolled back ${archive}`)
    }
  }
  return actions
}

/** Apply a proposal if the snapshot still matches the live log. */
export function finalize(paths: Paths, bundle: Bundle, proposal: Proposal): FinalizeResult {
  recover(paths)
  const dir = logDir(paths)
  const drift = snapshotDrift(dir, bundle)
  if (drift.length > 0) {
    return { ok: false, reason: `snapshot changed: ${drift.join(", ")}` }
  }
  const live = new Map(readLive(dir).map((e) => [e.file, e]))
  const applied: AppliedSummary[] = []
  try {
    for (const s of proposal.summaries) applied.push(applyOne(paths, dir, live, s))
  } catch (err) {
    recover(paths)
    return { ok: false, reason: (err as Error).message }
  }
  return { ok: true, applied }
}

/**
 * Undo one compaction: restore the archived originals over the summary
 * and remove the archive. Restored nested summaries keep their own
 * archives, so undo goes one level at a time.
 */
export function uncompact(paths: Paths, summaryFile: string): void {
  const dir = logDir(paths)
  const entry = JSON.parse(readFileSync(join(dir, summaryFile), "utf8")) as LogEntryJson
  if (!entry.compacted) throw new Error(`${summaryFile} is not a summary entry`)
  const archiveDir = join(paths.store, entry.compacted.archive)
  const originals = readdirSync(archiveDir).filter((f) => f.endsWith(".json") && f !== MANIFEST_FILE)
  for (const file of originals.filter((f) => f !== summaryFile)) {
    copyFileSync(join(archiveDir, file), join(dir, file))
  }
  const pending = join(dir, summaryFile + PENDING_SUFFIX)
  copyFileSync(join(archiveDir, summaryFile), pending)
  renameSync(pending, join(dir, summaryFile))
  rmSync(archiveDir, { recursive: true, force: true })
}
