import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  archiveDir,
  type LiveEntry,
  type LogEntryJson,
  readLive,
} from "./log-files"
import { type CompactionLimits, computeSplit, type Split } from "./split"

/**
 * prepare: snapshot the live log and write the compactor's input bundle
 * to the run dir. Nothing in the store is changed.
 */

export interface RunPaths {
  /** Root of the cue store. */
  store: string
  /** Canonical context address `<org>/<repo>/<slug>`. */
  address: string
  runDir: string
}

export interface SnapshotFile {
  file: string
  sha256: string
}

/** An entry as the compactor sees it; the lossy timestamp is dropped. */
export interface BundleEntry {
  file: string
  summary: boolean
  title: string
  trace: string | null
  found: string[]
  decided: string[]
  open: string[]
}

export interface Bundle {
  address: string
  contextDir: string
  limits: CompactionLimits
  snapshot: SnapshotFile[]
  split: Split
  entries: BundleEntry[]
  /** Archived originals per summary marked for merge, oldest first. */
  mergeOriginals: Record<string, BundleEntry[]>
}

export const BUNDLE_FILE = "bundle.json"

export function contextDir(paths: { store: string; address: string }): string {
  return join(paths.store, paths.address)
}

export function logDir(paths: { store: string; address: string }): string {
  return join(contextDir(paths), "log")
}

function bundleEntry(file: string, entry: LogEntryJson): BundleEntry {
  return {
    file,
    summary: entry.compacted !== undefined,
    title: entry.title,
    trace: entry.trace ?? null,
    found: entry.found ?? [],
    decided: entry.decided ?? [],
    open: entry.open ?? [],
  }
}

/** Original entries behind a summary, nested summaries expanded. */
export function archivedOriginals(store: string, address: string, entry: LogEntryJson): BundleEntry[] {
  if (!entry.compacted) return []
  const dir = archiveDir(store, address, entry.compacted)
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "manifest.json")
    .sort()
  return files.flatMap((file) => {
    const inner = JSON.parse(readFileSync(join(dir, file), "utf8")) as LogEntryJson
    return inner.compacted ? archivedOriginals(store, address, inner) : [bundleEntry(file, inner)]
  })
}

/** Write bundle.json for a run, or return null when nothing is due. */
export function prepare(paths: RunPaths, limits: CompactionLimits): Bundle | null {
  const live: LiveEntry[] = readLive(logDir(paths))
  const split = computeSplit(live, limits)
  if (!split) return null
  const byFile = new Map(live.map((e) => [e.file, e.entry]))
  const mergeOriginals: Record<string, BundleEntry[]> = {}
  for (const file of split.merge) {
    mergeOriginals[file] = archivedOriginals(paths.store, paths.address, byFile.get(file)!)
  }
  const bundle: Bundle = {
    address: paths.address,
    contextDir: contextDir(paths),
    limits,
    snapshot: live.map((e) => ({ file: e.file, sha256: e.sha256 })),
    split,
    entries: live.map((e) => bundleEntry(e.file, e.entry)),
    mergeOriginals,
  }
  mkdirSync(paths.runDir, { recursive: true })
  writeFileSync(join(paths.runDir, BUNDLE_FILE), JSON.stringify(bundle, null, 2))
  return bundle
}
