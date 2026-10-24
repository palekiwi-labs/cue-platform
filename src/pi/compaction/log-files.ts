import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"

/**
 * Direct access to a context's log directory. cue reads only immediate
 * `*.json` files there, so `.archive/` and `*.json.pending` files are
 * invisible to `cue log list`. Summary entries carry a `compacted` block,
 * an extra key cue's entry reader ignores.
 */

/**
 * Stamps are nanoseconds above Number.MAX_SAFE_INTEGER: JSON.parse
 * rounds them. Code never reads a parsed `timestamp`; file names are the
 * identity, and stamps written by compaction are digit strings, except
 * the summary's own `timestamp`, which is emitted as raw digits.
 */
export interface CompactedBlock {
  /** Stamp of the oldest original entry the summary replaces. */
  /** A rounded JSON number in legacy summaries; see entryFrom. */
  from: string | number
  /** Stamp of the newest original entry; also the summary's own. */
  to: string | number
  /** Number of original entries, nested summaries expanded. */
  count: number
  /** Canonical address of the archive directory. */
  archive: string
}

export interface LogEntryJson {
  /** Rounded by JSON.parse; do not use. */
  timestamp: number
  title: string
  trace: string | null
  found: string[]
  decided: string[]
  open: string[]
  compacted?: CompactedBlock
}

export interface LiveEntry {
  file: string
  sha256: string
  entry: LogEntryJson
}

export const ARCHIVE_DIR = ".archive"
export const PENDING_SUFFIX = ".pending"

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** Live entry file names, oldest first (names are zero-padded stamps). */
export function liveFiles(logDir: string): string[] {
  try {
    return readdirSync(logDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".json"))
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

export function readLive(logDir: string): LiveEntry[] {
  return liveFiles(logDir).map((file) => {
    const bytes = readFileSync(join(logDir, file))
    return {
      file,
      sha256: sha256(bytes),
      entry: JSON.parse(bytes.toString("utf8")) as LogEntryJson,
    }
  })
}

/** Stamp digits of an entry file name, leading zeros dropped. */
export function fileStamp(file: string): string {
  return BigInt(file.replace(/\.json$/, "")).toString()
}

/**
 * Absolute archive dir of a summary. Summaries written by the legacy
 * (now retired) cue-log-compact skill hold a context-relative `log/.archive/...` path.
 */
export function archiveDir(store: string, address: string, c: CompactedBlock): string {
  return c.archive.startsWith(`${address}/`) ? join(store, c.archive) : join(store, address, c.archive)
}

/**
 * Oldest original stamp an entry stands for. Legacy summaries hold
 * `from` as a rounded JSON number; their archive dir name
 * `<from>-<to>` carries the exact digits.
 */
export function entryFrom(live: LiveEntry): string {
  const c = live.entry.compacted
  if (!c) return fileStamp(live.file)
  if (typeof c.from === "string") return c.from
  const m = basename(c.archive).match(/^(\d+)-\d+$/)
  return m ? BigInt(m[1]!).toString() : fileStamp(live.file)
}

/** Number of original entries an entry stands for. */
export function entryCount(live: LiveEntry): number {
  return live.entry.compacted?.count ?? 1
}
